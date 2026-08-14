<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * 一条环境温湿度观测（小米 LYWSD03MMC，pvvx 明文广播）。
 *
 * 与 BmsLiveSnapshot 一样以 device_sn 关联，不走外键：中继在设备尚未被
 * ninecli 同步出来之前就可能需要上报环境数据。
 */
class EnvSample extends Model
{
    protected $table = 'env_samples';

    protected $fillable = [
        'device_sn', 'sensor_mac', 'temp_c', 'humidity_pct',
        'sensor_battery_mv', 'rssi', 'captured_at',
    ];

    protected $casts = [
        'temp_c'       => 'float',
        'humidity_pct' => 'float',
        'captured_at'  => 'datetime',
    ];
}
