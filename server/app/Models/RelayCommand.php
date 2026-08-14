<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * 一条待下发（或已完成）的中继远控指令。
 *
 * 与 BmsLiveSnapshot 一样以 device_sn 关联，不走外键：中继在设备尚未被
 * ninecli 同步出来之前就可能需要被远程拍照。
 */
class RelayCommand extends Model
{
    protected $table = 'relay_commands';

    /** 白名单：Controller 校验 in:… 时复用，避免两处漂移。 */
    public const COMMANDS = ['photo', 'shutdown', 'reboot', 'flush', 'restart', 'clear-backlog', 'update_apk', 'tap', 'swipe', 'key', 'screencap'];

    /**
     * 一条命令的全部可能状态。
     *
     * pending → dispatched → done / failed，或被 evtelemetry:sweep-commands 收进
     * expired 终态。expired 是「中继始终没回报，且重投次数已耗尽或已过有效期」，
     * 与 failed（中继执行了但失败了）语义不同，前端要分开显示。
     */
    public const STATUSES = ['pending', 'dispatched', 'done', 'failed', 'expired'];

    /**
     * 掉线后可以安全地退回 pending 重投的命令。
     *
     * 判定标准是「重复执行一次不会产生副作用」。APK 的命令去重表是内存态，
     * 进程一重启就清空，所以任何会导致中继自身重启的命令（reboot / restart /
     * shutdown / update_apk）一旦重投就可能进入无限重启循环；shell / tap /
     * swipe / key 的效果由调用者决定，同样不能替用户决定重放。
     * 这些命令掉线后由 evtelemetry:sweep-commands 直接判 expired，让人重下。
     */
    public const REQUEUEABLE = ['photo', 'screencap', 'flush'];

    /**
     * 同一条命令最多被 poll 领取几次。
     *
     * poll 领取时 attempts+1；sweep 把掉线未回报的退回 pending 重投，达到上限
     * 后转 expired。控制器与 sweeper 共用此常量，避免两处漂移导致「永远重投」
     * 或「一次都不重投」。
     */
    public const MAX_ATTEMPTS = 3;

    protected $fillable = [
        'device_sn', 'command', 'payload', 'status', 'attempts',
        'dispatched_at', 'executed_at', 'expires_at',
        'result', 'error', 'issued_by', 'issued_app_ver', 'client_token',
        'claim_token',
    ];

    protected $casts = [
        'payload'        => 'array',
        'result'         => 'array',
        'dispatched_at'  => 'datetime',
        'executed_at'    => 'datetime',
        'expires_at'     => 'datetime',
    ];

    /** 可以下发给中继的指令：未过期且仍在等待。 */
    public function scopePending($query)
    {
        return $query->where('status', 'pending')
            ->where(fn ($q) => $q->whereNull('expires_at')->orWhere('expires_at', '>', now()));
    }
}
