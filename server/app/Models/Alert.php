<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Durable record of a fired alert (theft / board-detach / etc.).
 *
 * HealthController::notify() writes here on every alert so they survive even
 * when no external webhook (ALERT_WEBHOOK_URL) is configured — previously such
 * alerts were silently dropped. A future dashboard widget can read this table.
 */
class Alert extends Model
{
    protected $table = 'alerts';

    protected $fillable = ['key', 'message', 'level', 'created_at'];

    public $timestamps = false;

    protected $casts = [
        'created_at' => 'datetime',
    ];
}
