<?php

namespace App\Services\Battery;

use App\Models\BatteryCalibration;
use App\Models\ChargeEvent;
use Illuminate\Support\Carbon;

/** Tracks charge sessions from measured board current, not NineCLI state. */
class BmsChargeSessionService
{
    public function ingest(string $deviceSn, Carbon $at, ?float $voltage, ?float $current, ?float $soc, ?array $temps): void
    {
        if ($current === null) return;
        $charging = $current >= 0.3;
        $open = ChargeEvent::query()
            ->where('device_sn', $deviceSn)
            ->whereNull('ended_at')
            ->orderByDesc('started_at')
            ->first();

        if (! $charging) {
            if ($open !== null && $at->greaterThan($open->started_at)) {
                $open->forceFill([
                    'ended_at' => $at,
                    'end_voltage' => $voltage,
                    'detection_method' => $open->detection_method ?: 'bms_current',
                ])->save();
            }
            return;
        }

        $tempValues = array_values(array_filter($temps ?? [], 'is_numeric'));
        $temp = $tempValues !== [] ? array_sum($tempValues) / count($tempValues) : null;
        if ($open === null) {
            $open = ChargeEvent::query()->create([
                'device_sn' => $deviceSn,
                'started_at' => $at,
                'start_voltage' => $voltage,
                'avg_temp' => $temp,
                'peak_voltage' => $voltage,
                'is_full_charge' => false,
                'detection_method' => 'bms_current',
            ]);
        }

        $cal = BatteryCalibration::query()->where('device_sn', $deviceSn)->first();
        $fullVoltage = $cal?->bms_full_charge_voltage !== null ? (float) $cal->bms_full_charge_voltage : null;
        $isFull = ($soc !== null && $soc >= 99.0)
            || ($voltage !== null && $fullVoltage !== null && $voltage >= $fullVoltage - 0.05);
        $open->peak_voltage = max((float) ($open->peak_voltage ?? 0), (float) ($voltage ?? 0));
        if ($temp !== null) $open->avg_temp = $open->avg_temp === null ? $temp : ((float) $open->avg_temp * 0.9 + $temp * 0.1);
        if ($isFull) $open->is_full_charge = true;
        $open->save();
    }
}
