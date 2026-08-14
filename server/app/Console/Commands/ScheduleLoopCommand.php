<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\Process\Process;

class ScheduleLoopCommand extends Command
{
    protected $signature = 'evtelemetry:schedule-loop {--tick=30}';
    protected $description = 'Tight loop: poll devices, process queue, backfill, analyze pending rides';

    public function handle(): int
    {
        $tick = max(5, min((int) $this->option('tick'), 300));

        // ── Single-instance guard (A-19) ──────────────────────────────────
        // systemctl restart overlaps old+new; without a guard both polls run and
        // both write SQLite, spiking "database is locked". We use a self-expiring
        // "alive" timestamp rather than a hard lock so a crash that fails to
        // release never dead-locks the service — the key frees itself after the
        // TTL and a fresh restart can take over.
        $lock = fopen(storage_path('framework/schedule-loop.lock'), 'c+');
        if ($lock === false || ! flock($lock, LOCK_EX | LOCK_NB)) {
            $this->info('schedule-loop: another process owns the scheduler lock.');
            if (is_resource($lock)) fclose($lock);
            return self::SUCCESS;
        }
        ftruncate($lock, 0);
        fwrite($lock, (string) getmypid());
        fflush($lock);
        register_shutdown_function(static function () use ($lock): void {
            if (is_resource($lock)) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
        });

        $interval = 5 * 60;
        $nextPoll = time();
        $pollCount = 0;
        $loopCount = 0;
        // Track which poll# already ran the side tasks so we only fire once
        // per eligible poll — not every tick while pollCount % 3 === 0.
        $lastSideTaskPoll = 0;

        $this->info("schedule-loop starting; tick={$tick}s, interval={$interval}s");

        // Daily retention marker — prune runs on the first tick at/after 03:00,
        // persisted to Cache so a service restart later the same day doesn't
        // re-run it (A-23). In-process state was lost on every restart.
        $lastPruneDate = (string) Cache::get('evtelemetry:last-prune-date', '');

        while (true) {
            $loopCount++;
            $now = time();
            $justPolled = false;

            // Keep the single-instance heartbeat fresh every iteration (A-19).
            // ---- daily retention (03:00 local, once per calendar day) ----
            $today = date('Y-m-d');
            if ((int) date('H') >= 3 && $lastPruneDate !== $today) {
                $lastPruneDate = $today;
                Cache::put('evtelemetry:last-prune-date', $today, now()->addDay());
                $ts = date('Y-m-d H:i:s');
                $this->info("[{$ts}] loop={$loopCount} running evtelemetry:prune-history");
                $code = $this->callFresh('evtelemetry:prune-history');
                if ($code !== 0) {
                    $this->warn("prune-history returned code {$code}");
                }
            }

            // ---- process queue (drain a few jobs per tick) ----
            for ($i = 0; $i < 5; $i++) {
                $code = $this->callFresh('queue:work', ['--stop-when-empty', '--once', '--tries=1'], quiet: true);
                if ($code !== 0) {
                    break;
                }
            }

            // ---- poll ----
            if ($now >= $nextPoll) {
                $ts = date('Y-m-d H:i:s');
                $this->info("[{$ts}] loop={$loopCount} running evtelemetry:poll-devices");
                $code = $this->callFresh('evtelemetry:poll-devices');
                if ($code !== 0) {
                    $this->warn("poll returned code {$code}");
                }
                // 远控指令收尾：把掉线卡死的 dispatched 退回重投 / 转终态。
                // 跟着 poll 走（5 分钟一次）就够了——stale 窗口是 10 分钟，
                // 没必要每个 tick 都多起一个 PHP 子进程。
                $code = $this->callFresh('evtelemetry:sweep-commands', quiet: true);
                if ($code !== 0) {
                    $this->warn("sweep-commands returned code {$code}");
                }

                $nextPoll = $now + $interval;
                $pollCount++;
                $justPolled = true;
            }

            // ---- side tasks: once every 3rd poll, immediately after that poll ----
            if (
                $justPolled
                && $pollCount > 0
                && $pollCount % 3 === 0
                && $pollCount !== $lastSideTaskPoll
            ) {
                $lastSideTaskPoll = $pollCount;
                $ts = date('Y-m-d H:i:s');

                // NineCLI provides the authoritative ride list and peak-speed trail.
                $this->info("[{$ts}] loop={$loopCount} poll#={$pollCount} running evtelemetry:backfill-ride-max-speed --limit=1");
                $code = $this->callFresh('evtelemetry:backfill-ride-max-speed', ['--limit=1']);
                if ($code !== 0) {
                    $this->warn("backfill returned code {$code}");
                }
            }

            sleep($tick);
        }
    }

    /**
     * Run an artisan command as a FRESH subprocess.
     *
     * @param  list<string>  $args
     */
    private function callFresh(string $command, array $args = [], bool $quiet = false): int
    {
        $process = new Process(
            array_merge([PHP_BINARY, base_path('artisan'), $command], $args),
            base_path(),
        );
        $process->setTimeout(300);

        $buffer = '';
        try {
            $process->run(function ($type, $data) use (&$buffer, $quiet) {
                $buffer .= $data;
                if (! $quiet) {
                    $this->output->write($data);
                }
            });
        } catch (\Throwable $e) {
            $this->warn("{$command} exception: " . $e->getMessage());
            return 1;
        }

        $code = $process->getExitCode() ?? 1;
        if ($quiet && $code !== 0 && $buffer !== '') {
            $this->output->write($buffer);
        }
        return $code;
    }
}
