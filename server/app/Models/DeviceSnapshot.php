<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DeviceSnapshot extends Model
{
    protected $fillable = [
        'device_id',
        'gsm',
        'gsm_time',
        'pwr',
        'dump_energy',
        'bms_voltage',
        'batt_temp',
        'bms_cycles',
        'bms_score',
        'charging_power',
        'estimate_mileage',
        'location_desc',
        'latitude',
        'longitude',
        'charging_state',
        'power_status',
        'lock_status',
        'remain_charge_time',
        'minute_bucket',
        'raw',
    ];

    protected function casts(): array
    {
        return [
            'gsm' => 'integer',
            'gsm_time' => 'integer',
            'pwr' => 'integer',
            'dump_energy' => 'integer',
            'estimate_mileage' => 'float',
            'bms_voltage' => 'float',
            'batt_temp' => 'float',
            'bms_cycles' => 'integer',
            'bms_score' => 'integer',
            'charging_power' => 'float',
            'latitude' => 'float',
            'longitude' => 'float',
            'charging_state' => 'integer',
            'power_status' => 'integer',
            'lock_status' => 'integer',
            'raw' => 'array',
        ];
    }

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }
}
