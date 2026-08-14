<?php

namespace App\Services\Calibration;

/**
 * Static OCV → SOC lookup for the default 14S high-voltage NMC profile.
 *
 * The pack is 14S: per-cell full charge is 4.32V (≈60.5V pack), the BMS
 * The dashboard can derive SOC from a configurable pack-voltage profile when
 * a direct BMS reading is unavailable. Vehicle-reported SOC remains a fallback
 * because its calibration may target a different battery configuration.
 *
 * Anchors are resting-OCV approximations for HV-NMC (4.32V full). Under
 * riding load the terminal voltage sags below OCV, so the displayed SOC
 * dips a few points during a ride and recovers at rest — that is expected
 * behaviour for a voltage-based estimate, and the learned curve
 * (SocCurveFitter) remains available as a cross-check.
 */
class VoltageSocCurve
{
    public const CELL_COUNT = 14;
    public const CELL_FULL_V = 4.32;
    public const CELL_CUTOFF_V = 3.0;
    public const PACK_FULL_V = 60.48;   // 14 × 4.32
    public const PACK_CUTOFF_V = 42.0;  // 14 × 3.0

    /**
     * Per-cell OCV → SOC anchors (descending voltage). Piecewise-linear
     * between neighbours; clamped outside the ends.
     *
     * @var list<array{0: float, 1: float}>
     */
    private const CELL_ANCHORS = [
        [4.32, 1.00],
        [4.25, 0.95],
        [4.20, 0.90],
        [4.15, 0.85],
        [4.10, 0.80],
        [4.05, 0.74],
        [4.00, 0.68],
        [3.95, 0.62],
        [3.90, 0.56],
        [3.85, 0.50],
        [3.80, 0.44],
        [3.75, 0.38],
        [3.70, 0.31],
        [3.65, 0.25],
        [3.60, 0.19],
        [3.55, 0.14],
        [3.50, 0.10],
        [3.45, 0.07],
        [3.40, 0.05],
        [3.30, 0.02],
        [3.20, 0.01],
        [3.00, 0.00],
    ];

    /** Pack voltage (V) → SOC fraction 0..1. */
    public static function socFromPackVoltage(float $packVoltage): float
    {
        $cell = $packVoltage / self::CELL_COUNT;
        $anchors = self::CELL_ANCHORS;

        if ($cell >= $anchors[0][0]) {
            return 1.0;
        }
        $last = $anchors[count($anchors) - 1];
        if ($cell <= $last[0]) {
            return 0.0;
        }

        for ($i = 0; $i < count($anchors) - 1; $i++) {
            [$vHi, $sHi] = $anchors[$i];
            [$vLo, $sLo] = $anchors[$i + 1];
            if ($cell <= $vHi && $cell >= $vLo) {
                $t = ($cell - $vLo) / ($vHi - $vLo);
                return max(0.0, min(1.0, $sLo + $t * ($sHi - $sLo)));
            }
        }

        return 0.0;
    }

    /** Pack voltage (V) → SOC percent 0..100 (1 decimal). */
    public static function pctFromPackVoltage(float $packVoltage): float
    {
        return round(self::socFromPackVoltage($packVoltage) * 100, 1);
    }
}
