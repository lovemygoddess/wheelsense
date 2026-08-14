<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DeviceRideHistory extends Model
{
    protected $table = 'device_ride_history';

    protected $fillable = [
        'device_id',
        'ride_id',
        'month',
        'started_at',
        'ended_at',
        'mileage',
        'energy',
        'energy_source',
        'energy_coverage',
        'wh_per_km',
        'max_speed_kph',
        'speed_analysis_status',
        'analyzed_at',
        'payload',
    ];

    protected $casts = [
        'started_at' => 'datetime',
        'ended_at' => 'datetime',
        'mileage' => 'float',
        'energy' => 'float',
        'energy_coverage' => 'float',
        'wh_per_km' => 'float',
        'max_speed_kph' => 'float',
        'analyzed_at' => 'datetime',
        'payload' => 'array',
    ];

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }
}
