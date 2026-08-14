<?php

namespace App\Console\Commands;

use App\Models\RelayCommand;
use Illuminate\Console\Command;

/**
 * 给远控指令队列收尾：把卡死的 dispatched 退回重投，把没救的转终态。
 *
 * 背景：poll 只查 status='pending'，一旦中继在「收到命令」与「回报结果」之间
 * 掉电（充电宝供电下是常态）或 su 弹框卡死，那一行就永远停在 dispatched——
 * poll 不会再取，也没有任何超时把它推向终态。表现是仪表盘一直显示「执行中」，
 * 行数还会无限增长（prune 只清 done/failed）。
 *
 * 三步处理，顺序不能颠倒：
 *  1. dispatched 且超过 --stale 分钟未回报、attempts 未耗尽、且命令本身可安全
 *     重复执行 → 退回 pending 重投。
 *  2. 已过 expires_at 的 pending/dispatched → 终态 expired。
 *  3. 第 1 步之后仍然卡着的 stale dispatched（按定义就是「不可重投」或「重投
 *     已耗尽」），以及 attempts 已耗尽却还挂着的 pending → 终态 expired。
 *
 * 为什么不无差别重投：APK 的命令去重表是内存态，进程重启即清空。若把 reboot /
 * restart / update_apk 也退回 pending，中继重启后会再次领到同一条 id 并再次
 * 重启——直到 attempts 耗尽为止的重启循环。尾箱里的中继一旦进这个循环，整套
 * 监控就废了。故只重投「重复执行无副作用」的命令，其余直接判终态由人重下。
 *
 * 幂等，可任意频率重复执行；每次三条 UPDATE，开销可忽略。
 */
class SweepRelayCommandsCommand extends Command
{
    protected $signature = 'evtelemetry:sweep-commands {--stale=10 : dispatched 超过多少分钟未回报即视为掉线}';
    protected $description = 'Requeue stalled dispatched commands and expire the hopeless ones';

    public function handle(): int
    {
        $stale = max(1, (int) $this->option('stale'));
        $cutoff = now()->subMinutes($stale);

        // 「已掉线」= 领走时间为空（脏数据）或早于 cutoff。
        $isStale = fn ($q) => $q->whereNull('dispatched_at')->orWhere('dispatched_at', '<', $cutoff);

        // ---- 1) 掉线未回报、可安全重复执行 → 退回 pending 重投 ----
        // attempts 在 poll 领取时已经 +1，因此天然限次，不会无限重试。
        // 这里不动 attempts，下次 poll 会继续往上加。
        $requeued = RelayCommand::query()
            ->where('status', 'dispatched')
            ->where('attempts', '<', RelayCommand::MAX_ATTEMPTS)
            ->whereIn('command', RelayCommand::REQUEUEABLE)
            ->where($isStale)
            ->update(['status' => 'pending', 'claim_token' => null]);

        // ---- 2) 硬性有效期到点 → 终态 expired ----
        // 中继长期离线（尾箱无 SIM）时命令会一直停在 pending，这是正常的：
        // 只有 issue 时设定的 expires_at 才是它的死线。
        $expiredDeadline = RelayCommand::query()
            ->whereIn('status', ['pending', 'dispatched'])
            ->whereNotNull('expires_at')
            ->where('expires_at', '<=', now())
            ->update([
                'status'      => 'expired',
                'claim_token' => null,
                'executed_at' => now(),
                'error'       => '已过有效期，中继始终未完成这条命令',
            ]);

        // ---- 3) 领走后失联、且不会再重投的 → 终态 expired ----
        // 走到这里的 stale dispatched，按定义只可能是「命令不可安全重投」或
        // 「重投次数已耗尽」——第 1 步已经把该救的都救走了。
        // 另外捡一下 attempts 耗尽却还挂在 pending 的行：poll 的 attempts <
        // MAX 过滤会让它永远取不走，留着只是噪音。
        $expiredStalled = RelayCommand::query()
            ->where(fn ($q) => $q
                ->where(fn ($w) => $w->where('status', 'dispatched')->where($isStale))
                ->orWhere(fn ($w) => $w
                    ->where('status', 'pending')
                    ->where('attempts', '>=', RelayCommand::MAX_ATTEMPTS)))
            ->update([
                'status'      => 'expired',
                'claim_token' => null,
                'executed_at' => now(),
                'error'       => '中继取走后未回报结果，已放弃重投',
            ]);

        $expired = $expiredDeadline + $expiredStalled;
        if ($requeued > 0 || $expired > 0) {
            $this->info("sweep-commands: requeued={$requeued} expired={$expired}");
        }

        return self::SUCCESS;
    }
}
