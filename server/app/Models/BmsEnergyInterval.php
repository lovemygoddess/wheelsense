<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BmsEnergyInterval extends Model
{
    protected $fillable = [
        'device_sn', 'started_at', 'ended_at', 'energy_wh',
        'duration_seconds', 'start_power_w', 'end_power_w',
    ];

    protected function casts(): array
    {
        return [
            'started_at' => 'datetime',
            'ended_at' => 'datetime',
            'energy_wh' => 'float',
            'start_power_w' => 'float',
            'end_power_w' => 'float',
        ];
    }
}
