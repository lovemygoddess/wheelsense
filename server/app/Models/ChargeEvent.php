<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ChargeEvent extends Model
{
    protected $fillable = [
        'device_sn',
        'started_at',
        'ended_at',
        'start_voltage',
        'end_voltage',
        'avg_temp',
        'peak_voltage',
        'is_full_charge',
        'detection_method',
    ];

    protected function casts(): array
    {
        return [
            'started_at' => 'datetime',
            'ended_at' => 'datetime',
            'start_voltage' => 'float',
            'end_voltage' => 'float',
            'avg_temp' => 'float',
            'peak_voltage' => 'float',
            'is_full_charge' => 'boolean',
        ];
    }
}
