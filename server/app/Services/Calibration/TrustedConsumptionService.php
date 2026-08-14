<?php

namespace App\Services\Calibration;

use App\Models\BatteryCalibration;
use App\Models\Device;
use App\Models\DeviceRideHistory;
use Illuminate\Support\Carbon;

/**
 * Consumption used by every range and trip surface.
 *
 * Only ride windows with >=85% protection-board coverage may train the
 * long-term value. NineCLI EC and the retired pseudo-coulomb samples are never
 * read. When the relay has no usable history, the voltage-derived calibration
 * remains available as an explicitly lower-confidence fallback.
 */
class TrustedConsumptionService
{
    /** @return array{wh_per_km:?float,sample_count:int,source:?string} */
    public function estimate(string $deviceSn): array
    {
        $deviceId = Device::query()->where('sn', $deviceSn)->value('id');
        $rows = $deviceId === null
            ? collect()
            : DeviceRideHistory::query()
                ->where('device_id', $deviceId)
                ->where('energy_source', 'bms_interval')
                ->where('energy_coverage', '>=', 0.85)
                ->where('mileage', '>=', CalibrationConstants::MIN_RIDE_KM_FOR_SAMPLE)
                ->whereNotNull('wh_per_km')
                ->orderByDesc('ended_at')
                ->limit(CalibrationConstants::MAX_CONSUMPTION_SAMPLES)
                ->get(['wh_per_km', 'ended_at']);

        $values = [];
        foreach ($rows as $row) {
            $value = (float) $row->wh_per_km;
            if ($this->plausible($value)) {
                $values[] = ['value' => $value, 'recorded_at' => $row->ended_at];
            }
        }

        if (count($values) >= 3) {
            $values = $this->madFilter($values);
            $weighted = 0.0;
            $weightSum = 0.0;
            foreach ($values as $value) {
                $daysAgo = $value['recorded_at']
                    ? max(0, (int) Carbon::parse($value['recorded_at'])->diffInDays(Carbon::now()))
                    : 0;
                $weight = CalibrationConstants::decayWeight($daysAgo);
                $weighted += $value['value'] * $weight;
                $weightSum += $weight;
            }
            if ($weightSum > 0) {
                return [
                    'wh_per_km' => round($weighted / $weightSum, 3),
                    'sample_count' => count($values),
                    'source' => 'bms_measured',
                ];
            }
        }

        $fallback = BatteryCalibration::query()
            ->where('device_sn', $deviceSn)
            ->value('wh_per_km_current');
        $fallback = is_numeric($fallback) ? (float) $fallback : null;

        return [
            'wh_per_km' => $fallback !== null && $this->plausible($fallback) ? round($fallback, 3) : null,
            'sample_count' => 0,
            'source' => $fallback !== null && $this->plausible($fallback) ? 'voltage_model' : null,
        ];
    }

    /** @return array{energy_wh:?float,wh_per_km:?float,source:?string} */
    public function fallbackForRide(float $mileageKm, ?float $fallbackWhPerKm): array
    {
        if ($fallbackWhPerKm !== null && $mileageKm > 0 && $this->plausible($fallbackWhPerKm)) {
            return [
                'energy_wh' => round($fallbackWhPerKm * $mileageKm, 1),
                'wh_per_km' => round($fallbackWhPerKm, 2),
                'source' => 'trusted_average',
            ];
        }

        return ['energy_wh' => null, 'wh_per_km' => null, 'source' => null];
    }

    /** @param list<array{value:float,recorded_at:mixed}> $values */
    private function madFilter(array $values): array
    {
        if (count($values) < 5) {
            return $values;
        }
        $median = $this->median(array_column($values, 'value'));
        $mad = $this->median(array_map(static fn (array $v): float => abs($v['value'] - $median), $values));
        if ($mad <= 1e-6) {
            return $values;
        }
        $limit = 3.0 * 1.4826 * $mad;
        return array_values(array_filter($values, static fn (array $v): bool => abs($v['value'] - $median) <= $limit));
    }

    private function plausible(float $value): bool
    {
        return $value >= CalibrationConstants::MIN_PHYSICAL_WH_PER_KM
            && $value <= CalibrationConstants::MAX_PHYSICAL_WH_PER_KM;
    }

    /** @param list<float> $values */
    private function median(array $values): float
    {
        sort($values);
        $n = count($values);
        return (float) ($n % 2 ? $values[intdiv($n, 2)] : ($values[$n / 2 - 1] + $values[$n / 2]) / 2.0);
    }
}
