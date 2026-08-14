<?php

namespace App\Services\Rides;

use App\Models\DeviceSnapshot;
use App\Services\Calibration\VoltageSocCurve;
use Illuminate\Support\Carbon;

/**
 * Ride energy by the *voltage method* — the only estimate this project trusts.
 *
 * Upstream `ec` is derived from the vehicle's SOC percentage, and that
 * percentage comes off a curve that reads 100% anywhere between 4.32V and
 * 4.20V per cell. The knee makes the first ~25km of a full pack look almost
 * free and the next 25km look brutal, so `ec` is a distorted estimate and
 * never a measurement.
 *
 * What we do instead: read pack voltage before and after the ride, convert
 * both through the resting-OCV table (VoltageSocCurve, 14S HV-NMC 4.32V full),
 * and multiply the SOC drop by the pack's usable energy. Voltage is a
 * continuous physical quantity — no knee, no vendor rounding.
 *
 * Two voltage sources, in order of trust:
 *   1. The relay's own start/end pack voltage (ANT board, direct measurement).
 *   2. `device_snapshots.bms_voltage` (ninecli poll, ~1 sample / 5 min).
 *
 * For (2) we deliberately pick the sample *before* the ride starts and the
 * one *after* it ends: both are at-rest readings, unpolluted by the I×R sag
 * that would otherwise inflate the apparent drop.
 */
class VoltageRideEnergyEstimator
{
    /** How far from a ride boundary we will still accept a voltage sample. */
    public const LOOKUP_TOLERANCE_MIN = 30;

    /** Below this the "drop" is curve/ADC noise, not consumption. */
    private const MIN_SOC_DROP_PCT = 0.25;

    /** Fallback pack energy when calibration priors are missing (54V × 95Ah). */
    public const FALLBACK_CAPACITY_WH = 5130.0;

    /** @var list<array{t:int, v:float}> ascending by timestamp */
    private array $samples;

    /** @param list<array{t:int, v:float}> $samples */
    private function __construct(array $samples)
    {
        $this->samples = $samples;
    }

    /**
     * Load every usable snapshot voltage in the window once, so a whole
     * month of rides costs one query instead of two per ride.
     */
    public static function load(int $deviceId, Carbon $from, Carbon $to): self
    {
        $rows = DeviceSnapshot::query()
            ->where('device_id', $deviceId)
            ->whereNotNull('bms_voltage')
            ->where('bms_voltage', '>', 30)
            ->whereBetween('created_at', [
                $from->copy()->subMinutes(self::LOOKUP_TOLERANCE_MIN),
                $to->copy()->addMinutes(self::LOOKUP_TOLERANCE_MIN),
            ])
            ->orderBy('created_at')
            ->get(['created_at', 'bms_voltage']);

        $samples = [];
        foreach ($rows as $row) {
            if ($row->created_at === null) {
                continue;
            }
            $samples[] = ['t' => $row->created_at->getTimestamp(), 'v' => (float) $row->bms_voltage];
        }

        return new self($samples);
    }

    /** An estimator with no snapshot history — relay voltages still work. */
    public static function empty(): self
    {
        return new self([]);
    }

    /**
     * Energy for one ride.
     *
     * @param float|null $relayStartV Pack voltage measured by the relay at ride start.
     * @param float|null $relayEndV   Pack voltage measured by the relay at ride end.
     *
     * @return array{
     *   energy_wh: float, soc_drop_pct: float, start_voltage_v: float,
     *   end_voltage_v: float, start_soc_pct: float, end_soc_pct: float,
     *   source: string
     * }|null  null when no trustworthy voltage pair exists.
     */
    public function estimate(
        ?Carbon $start,
        ?Carbon $end,
        float $capacityWh,
        ?float $relayStartV = null,
        ?float $relayEndV = null,
    ): ?array {
        $source = 'relay_voltage';
        $startV = $this->plausible($relayStartV);
        $endV = $this->plausible($relayEndV);

        if ($startV === null || $endV === null) {
            if ($start === null || $end === null) {
                return null;
            }
            $source = 'snapshot_voltage';
            // Before the ride: the last at-rest reading. After the ride: the
            // first reading once the pack has stopped delivering current.
            $startV = $this->nearest($start->getTimestamp(), preferBefore: true);
            $endV = $this->nearest($end->getTimestamp(), preferBefore: false);
        }

        if ($startV === null || $endV === null) {
            return null;
        }

        $startSoc = VoltageSocCurve::pctFromPackVoltage($startV);
        $endSoc = VoltageSocCurve::pctFromPackVoltage($endV);
        $drop = $startSoc - $endSoc;

        // A negative drop means the pack was charging (or the sample pair
        // straddles a charge). Either way it is not ride consumption.
        if ($drop < self::MIN_SOC_DROP_PCT) {
            return null;
        }

        return [
            'energy_wh' => round($drop / 100.0 * $capacityWh, 1),
            'soc_drop_pct' => round($drop, 2),
            'start_voltage_v' => round($startV, 2),
            'end_voltage_v' => round($endV, 2),
            'start_soc_pct' => $startSoc,
            'end_soc_pct' => $endSoc,
            'source' => $source,
        ];
    }

    /** Reject obviously impossible pack voltages (0V reads, disconnected BMS). */
    private function plausible(?float $v): ?float
    {
        if ($v === null) {
            return null;
        }
        return ($v >= 30.0 && $v <= 70.0) ? $v : null;
    }

    /**
     * Closest sample to $ts, preferring the given side; falls back to the
     * other side when nothing within tolerance exists on the preferred one.
     */
    private function nearest(int $ts, bool $preferBefore): ?float
    {
        if ($this->samples === []) {
            return null;
        }
        $tol = self::LOOKUP_TOLERANCE_MIN * 60;
        $before = null; $beforeGap = PHP_INT_MAX;
        $after = null; $afterGap = PHP_INT_MAX;

        foreach ($this->samples as $s) {
            $gap = $s['t'] - $ts;
            if ($gap <= 0 && -$gap <= $tol && -$gap < $beforeGap) {
                $beforeGap = -$gap; $before = $s['v'];
            } elseif ($gap > 0 && $gap <= $tol && $gap < $afterGap) {
                $afterGap = $gap; $after = $s['v'];
            }
        }

        if ($preferBefore) {
            return $before ?? $after;
        }
        return $after ?? $before;
    }
}
