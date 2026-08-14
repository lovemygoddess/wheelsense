<?php

namespace App\Services\Rides;

use App\Models\BmsEnergyInterval;
use App\Models\BmsLiveSnapshot;
use Illuminate\Support\Carbon;

/** Integrates protection-board V×I frames without recording GPS or tracks. */
class BmsEnergyIntervalService
{
    private const MAX_GAP_SECONDS = 180;
    // Partial ride windows under-count energy. Do not extrapolate missing
    // high-load segments; require near-complete frame coverage instead.
    public const MIN_RIDE_COVERAGE = 0.85;

    public function recordFrame(string $deviceSn, Carbon $capturedAt, float $powerW): void
    {
        $previous = BmsLiveSnapshot::query()
            ->where('device_sn', $deviceSn)
            ->where('source', 'relay')
            ->where('crc_ok', true)
            ->where('is_heartbeat', false)
            ->whereNotNull('power_w')
            ->where('captured_at', '<', $capturedAt)
            ->orderByDesc('captured_at')
            ->first(['captured_at', 'power_w']);

        if ($previous?->captured_at === null || $previous->power_w === null) {
            return;
        }
        $seconds = $previous->captured_at->diffInSeconds($capturedAt);
        if ($seconds <= 0 || $seconds > self::MAX_GAP_SECONDS) {
            return;
        }

        // Signed convention is negative while discharging. Charge and idle
        // intervals contribute zero to ride consumption.
        $startDischargeW = max(0.0, -(float) $previous->power_w);
        $endDischargeW = max(0.0, -$powerW);
        $energyWh = (($startDischargeW + $endDischargeW) / 2.0) * $seconds / 3600.0;
        if ($energyWh <= 0.0001) {
            return;
        }

        BmsEnergyInterval::query()->firstOrCreate([
            'device_sn' => $deviceSn,
            'started_at' => $previous->captured_at,
            'ended_at' => $capturedAt,
        ], [
            'energy_wh' => round($energyWh, 5),
            'duration_seconds' => $seconds,
            'start_power_w' => (float) $previous->power_w,
            'end_power_w' => $powerW,
        ]);
    }

    /** @return array{energy_wh:?float,coverage:float,interval_count:int} */
    public function energyForWindow(string $deviceSn, ?Carbon $start, ?Carbon $end): array
    {
        if ($start === null || $end === null || $end->lessThanOrEqualTo($start)) {
            return ['energy_wh' => null, 'coverage' => 0.0, 'interval_count' => 0];
        }
        $rows = BmsEnergyInterval::query()
            ->where('device_sn', $deviceSn)
            ->where('ended_at', '>', $start)
            ->where('started_at', '<', $end)
            ->orderBy('started_at')
            ->get();

        $energy = 0.0;
        $covered = 0;
        foreach ($rows as $row) {
            $overlapStart = $row->started_at->greaterThan($start) ? $row->started_at : $start;
            $overlapEnd = $row->ended_at->lessThan($end) ? $row->ended_at : $end;
            $overlap = max(0, $overlapStart->diffInSeconds($overlapEnd));
            $duration = max(1, (int) $row->duration_seconds);
            $energy += (float) $row->energy_wh * min(1.0, $overlap / $duration);
            $covered += $overlap;
        }
        $rideSeconds = max(1, $start->diffInSeconds($end));
        $coverage = min(1.0, $covered / $rideSeconds);

        return [
            'energy_wh' => $coverage >= self::MIN_RIDE_COVERAGE && $energy > 0 ? round($energy, 1) : null,
            'coverage' => round($coverage, 3),
            'interval_count' => $rows->count(),
        ];
    }
}
