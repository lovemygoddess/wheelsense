<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Device extends Model
{
    protected $fillable = [
        'sn',
        'device_name',
        'model',
        'img',
        'vehicle_image',
        'raw',
        'relay_sample_idle_ms',
        'relay_sample_ride_ms',
        'relay_low_power',
        'relay_thermo_mac',
        'relay_poll_ms',
        'relay_monitor_secs',
        'relay_upload_ms',
    ];

    protected function casts(): array
    {
        return [
            'raw' => 'array',
            'relay_low_power' => 'boolean',
            'relay_poll_ms' => 'integer',
            'relay_monitor_secs' => 'integer',
            'relay_upload_ms' => 'integer',
        ];
    }

    public function snapshots(): HasMany
    {
        return $this->hasMany(DeviceSnapshot::class);
    }

    public function rideHistory(): HasMany
    {
        return $this->hasMany(DeviceRideHistory::class);
    }
}
