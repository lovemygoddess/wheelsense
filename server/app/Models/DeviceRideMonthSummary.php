<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One row per device per calendar month: authoritative ride aggregates
 * (count / mileage / energy / duration) from the upstream travel endpoint.
 */
class DeviceRideMonthSummary extends Model
{
    protected $table = 'device_ride_month_summary';

    protected $fillable = [
        'device_id',
        'month',
        'ride_count',
        'total_mileage_km',
        'total_duration_sec',
    ];

    protected function casts(): array
    {
        return [
            'ride_count' => 'integer',
            'total_mileage_km' => 'float',
            'total_duration_sec' => 'integer',
        ];
    }

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }
}
