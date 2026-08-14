<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BatteryCalibration extends Model
{
    protected $table = 'battery_calibration';

    protected $fillable = [
        'device_sn',
        'capacity_wh_estimate',
        'capacity_tolerance_pct',
        'wh_per_km_current',
        'wh_per_km_slope',
        'soc_curve_params',
        'soc_curve_version',
        'total_calibration_samples',
        'confidence_soc',
        'confidence_consumption',
        'last_calibrated_at',
        'is_calibrated',
        'chemistry_type',
        'cell_series_count',
        'bms_full_charge_voltage',
        'bms_cutoff_voltage',
        'max_charge_current_a',
        'charger_output_current_a',
        'ant_bms_displayed_power_w',
        'ant_bms_measured_current_a',
        'nominal_voltage',
        'nominal_capacity_ah',
        'priors_updated_at',
        'temp_bucket_cold_max_c',
        'temp_bucket_warm_max_c',
        'plateau_voltage_delta',
        'plateau_min_minutes',
        'capacity_ema_alpha_base',
        'ec_recent_avg',
        'ec_sample_count',
        'ec_deviation_pct',
        'ec_validation_status',
        'ec_validation_at',
        'cycle_count_baseline',
        'cycle_count_baseline_wh',
        'odometer_baseline_km',
        'odometer_baseline_ride_km',
    ];

    protected function casts(): array
    {
        return [
            'capacity_wh_estimate' => 'float',
            'capacity_tolerance_pct' => 'float',
            'wh_per_km_current' => 'float',
            'wh_per_km_slope' => 'float',
            'soc_curve_params' => 'array',
            'soc_curve_version' => 'integer',
            'total_calibration_samples' => 'integer',
            'confidence_soc' => 'float',
            'confidence_consumption' => 'float',
            'last_calibrated_at' => 'datetime',
            'is_calibrated' => 'boolean',
            'cell_series_count' => 'integer',
            'bms_full_charge_voltage' => 'float',
            'bms_cutoff_voltage' => 'float',
            'max_charge_current_a' => 'float',
            'charger_output_current_a' => 'float',
            'ant_bms_displayed_power_w' => 'float',
            'ant_bms_measured_current_a' => 'float',
            'nominal_voltage' => 'float',
            'nominal_capacity_ah' => 'float',
            'priors_updated_at' => 'datetime',
            'temp_bucket_cold_max_c' => 'float',
            'temp_bucket_warm_max_c' => 'float',
            'plateau_voltage_delta' => 'float',
            'plateau_min_minutes' => 'integer',
            'capacity_ema_alpha_base' => 'float',
            'ec_recent_avg' => 'float',
            'ec_sample_count' => 'integer',
            'ec_deviation_pct' => 'float',
            'ec_validation_at' => 'datetime',
            'cycle_count_baseline' => 'integer',
            'cycle_count_baseline_wh' => 'float',
            'odometer_baseline_km' => 'float',
            'odometer_baseline_ride_km' => 'float',
        ];
    }

    /** Default values for new tunable fields. Used as fallback when the column is null. */
    public const DEFAULT_TEMP_BUCKET_COLD_MAX = 5.0;
    public const DEFAULT_TEMP_BUCKET_WARM_MAX = 20.0;
    public const DEFAULT_PLATEAU_VOLTAGE_DELTA = 0.30;
    public const DEFAULT_PLATEAU_MIN_MINUTES = 15;
    public const DEFAULT_CAPACITY_EMA_ALPHA_BASE = 0.050;

    public function getTempBucketColdMaxC(): float
    {
        return $this->temp_bucket_cold_max_c !== null
            ? (float) $this->temp_bucket_cold_max_c
            : self::DEFAULT_TEMP_BUCKET_COLD_MAX;
    }

    public function getTempBucketWarmMaxC(): float
    {
        return $this->temp_bucket_warm_max_c !== null
            ? (float) $this->temp_bucket_warm_max_c
            : self::DEFAULT_TEMP_BUCKET_WARM_MAX;
    }

    public function getPlateauVoltageDelta(): float
    {
        return $this->plateau_voltage_delta !== null
            ? (float) $this->plateau_voltage_delta
            : self::DEFAULT_PLATEAU_VOLTAGE_DELTA;
    }

    public function getPlateauMinMinutes(): int
    {
        return $this->plateau_min_minutes !== null
            ? (int) $this->plateau_min_minutes
            : self::DEFAULT_PLATEAU_MIN_MINUTES;
    }

    public function getCapacityEmaAlphaBase(): float
    {
        return $this->capacity_ema_alpha_base !== null
            ? (float) $this->capacity_ema_alpha_base
            : self::DEFAULT_CAPACITY_EMA_ALPHA_BASE;
    }

    /**
     * Voltage range where SOC fitting is allowed (BMS-protected window).
     * Returns [min, max] or null when priors aren't set.
     *
     * @return array{0: float, 1: float}|null
     */
    public function voltageWindow(): ?array
    {
        $cutoff = $this->bms_cutoff_voltage !== null ? (float) $this->bms_cutoff_voltage : null;
        $full = $this->bms_full_charge_voltage !== null ? (float) $this->bms_full_charge_voltage : null;
        if ($cutoff === null || $full === null || $cutoff >= $full) return null;
        return [$cutoff, $full];
    }

    /** Pack-level nominal capacity in Wh (nominal V × nominal Ah) or null if priors missing. */
    public function priorCapacityWh(): ?float
    {
        $v = $this->nominal_voltage !== null ? (float) $this->nominal_voltage : null;
        $ah = $this->nominal_capacity_ah !== null ? (float) $this->nominal_capacity_ah : null;
        return ($v !== null && $ah !== null) ? round($v * $ah, 2) : null;
    }

    /**
     * Acceptable capacity bounds relative to prior (default ±20%).
     * Returns [min, max] or null when priors are missing.
     *
     * @return array{0: float, 1: float}|null
     */
    public function capacityAcceptableWindow(): ?array
    {
        $prior = $this->priorCapacityWh();
        if ($prior === null) return null;
        $tol = $this->capacity_tolerance_pct !== null
            ? (float) $this->capacity_tolerance_pct
            : 20.0;
        $min = $prior * (1.0 - $tol / 100.0);
        $max = $prior * (1.0 + $tol / 100.0);
        return [$min, $max];
    }
}
