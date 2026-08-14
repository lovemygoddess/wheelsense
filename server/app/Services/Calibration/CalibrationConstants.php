<?php

namespace App\Services\Calibration;

class CalibrationConstants
{
    /**
     * Algorithm internals — NOT exposed via Settings UI. Adjusting these
     * changes calibration behavior in subtle ways; keep them hardcoded.
     */
    public const TEMP_BUCKETS = ['cold', 'normal', 'warm'];

    public const MIN_VOLTAGE_SAMPLES_PER_BUCKET = 5;

    public const MAX_CONSUMPTION_SAMPLES = 200;

    /**
     * Physical plausibility bounds for a ride's Wh/km (SOC-derived).
     * Real-world for this vehicle (14S NMC e-moped, 90 km/h capable):
     * ~25-70 Wh/km depending on speed/temp. Bounds are deliberately wide
     * to only catch attribution failures (e.g. SOC-curve refit shifting
     * delta_soc between rides), not legitimate hard riding.
     */
    public const MIN_PHYSICAL_WH_PER_KM = 5.0;
    public const MAX_PHYSICAL_WH_PER_KM = 150.0;

    /**
     * Minimum ride distance for a consumption sample to be usable.
     * Short rides (<2 km) have SOC-attribution noise comparable to the
     * signal itself (curve quantization, rest-voltage rebound between
     * rides), producing absurd Wh/km values like 1684 from a 0.9 km ride.
     */
    public const MIN_RIDE_KM_FOR_SAMPLE = 2.0;

    public const WEIGHT_DECAY_LAMBDA = 0.97; // per day

    public const PLATEAU_FULL_THRESHOLD = 0.97; // >= 97% of peak

    public const BMS_FULL_FLOOR = 0.95; // >= 95% × BMS full

    public const BMS_END_VOLTAGE_THRESHOLD = 0.97; // end-of-charge fast-path

    public const SOC_MIN_SAMPLES_FOR_CALIBRATION = 5;

    /** Hardcoded cycle windows for plateau detection (not user-tunable). */
    public const PLATEAU_RECENT_WINDOW = 8;
    public const PLATEAU_MIN_SNAPSHOTS = 3;

    /**
     * Hard cap on rows scanned by the plateau time-window query. The window
     * itself is time-based (plateau_min_minutes); this only bounds the scan
     * for pathological sampling rates (web path can write 1 row/min).
     */
    public const PLATEAU_WINDOW_HARD_CAP = 120;

    /**
     * User-tunable defaults. When the calibration row has NULL for a column,
     * these are used. The actual runtime values come from BatteryCalibration
     * model accessors (getTempBucketColdMaxC, etc.).
     */
    public const DEFAULT_TEMP_BUCKET_COLD_MAX_C = 5.0;
    public const DEFAULT_TEMP_BUCKET_WARM_MAX_C = 20.0;
    public const DEFAULT_PLATEAU_VOLTAGE_DELTA = 0.30;
    public const DEFAULT_PLATEAU_MIN_MINUTES = 15;
    public const DEFAULT_CAPACITY_EMA_ALPHA_BASE = 0.050;

    /**
     * Classify a temperature reading into a bucket using the supplied boundaries.
     * Falls back to defaults if no boundaries provided.
     */
    public static function tempBucket(?float $tempC, ?float $coldMax = null, ?float $warmMax = null): string
    {
        $coldMax = $coldMax ?? self::DEFAULT_TEMP_BUCKET_COLD_MAX_C;
        $warmMax = $warmMax ?? self::DEFAULT_TEMP_BUCKET_WARM_MAX_C;
        if ($tempC === null) return 'normal';
        if ($tempC < $coldMax) return 'cold';
        if ($tempC > $warmMax) return 'warm';
        return 'normal';
    }

    public static function tempBucketLabel(string $bucket): string
    {
        return match ($bucket) {
            'cold' => '低温',
            'normal' => '常温',
            'warm' => '高温',
            default => $bucket,
        };
    }

    public static function decayWeight(int $daysAgo): float
    {
        return (float) (self::WEIGHT_DECAY_LAMBDA ** $daysAgo);
    }

    /** Round a datetime down to the minute (second-precision bucket). */
    public static function minuteBucket(\DateTimeInterface $t): string
    {
        return $t->format('Y-m-d H:i:00');
    }
}