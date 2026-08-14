<?php

namespace App\Services\Calibration;

use App\Models\BatteryCalibration;

/**
 * Read-only view of the per-device calibration settings. Provides
 * user-tunable values (with defaults from BatteryCalibration::DEFAULT_*)
 * and convenience helpers.
 */
class CalibrationSettings
{
    public function __construct(private readonly ?BatteryCalibration $cal) {}

    public function isCalibrated(): bool
    {
        return $this->cal?->is_calibrated === true;
    }

    // ---- temperature bucket boundaries
    public function tempBucketColdMaxC(): float
    {
        return $this->cal?->getTempBucketColdMaxC() ?? BatteryCalibration::DEFAULT_TEMP_BUCKET_COLD_MAX;
    }

    public function tempBucketWarmMaxC(): float
    {
        return $this->cal?->getTempBucketWarmMaxC() ?? BatteryCalibration::DEFAULT_TEMP_BUCKET_WARM_MAX;
    }

    public function tempBucket(?float $tempC): string
    {
        return CalibrationConstants::tempBucket(
            $tempC,
            $this->tempBucketColdMaxC(),
            $this->tempBucketWarmMaxC()
        );
    }

    // ---- algorithm thresholds (Plan B subset)
    public function plateauVoltageDelta(): float
    {
        return $this->cal?->getPlateauVoltageDelta() ?? BatteryCalibration::DEFAULT_PLATEAU_VOLTAGE_DELTA;
    }

    public function plateauMinMinutes(): int
    {
        return $this->cal?->getPlateauMinMinutes() ?? BatteryCalibration::DEFAULT_PLATEAU_MIN_MINUTES;
    }

    public function capacityEmaAlphaBase(): float
    {
        return $this->cal?->getCapacityEmaAlphaBase() ?? BatteryCalibration::DEFAULT_CAPACITY_EMA_ALPHA_BASE;
    }

    // ---- passed-through
    public function capacityWhEstimate(): ?float
    {
        return $this->cal?->capacity_wh_estimate !== null ? (float) $this->cal->capacity_wh_estimate : null;
    }

    public function whPerKmCurrent(): ?float
    {
        return $this->cal?->wh_per_km_current !== null ? (float) $this->cal->wh_per_km_current : null;
    }

    public function bmsFullChargeVoltage(): ?float
    {
        return $this->cal?->bms_full_charge_voltage !== null ? (float) $this->cal->bms_full_charge_voltage : null;
    }

    public function bmsCutoffVoltage(): ?float
    {
        return $this->cal?->bms_cutoff_voltage !== null ? (float) $this->cal->bms_cutoff_voltage : null;
    }

    public function maxChargeCurrentA(): ?float
    {
        return $this->cal?->max_charge_current_a !== null ? (float) $this->cal->max_charge_current_a : null;
    }

    /**
     * The configured charger's actual output current (amps).
     * When set, supersedes maxChargeCurrentA() for charge-power reporting
     * because the charger's real output is more accurate than the BMS spec max.
     */
    public function chargerOutputCurrentA(): ?float
    {
        return $this->cal?->charger_output_current_a !== null ? (float) $this->cal->charger_output_current_a : null;
    }

    /**
     * Resolve the effective charge current: the configured charger setting wins over
     * BMS spec max when both are present. Falls back to null when neither is set.
     */
    public function effectiveChargeCurrentA(): ?float
    {
        return $this->chargerOutputCurrentA() ?? $this->maxChargeCurrentA();
    }

    /**
     * A one-shot reading the user copies off the Ant BMS protection board
     * display during a charge session — used to compute power deviation.
     */
    public function antBmsDisplayedPowerW(): ?float
    {
        return $this->cal?->ant_bms_displayed_power_w !== null ? (float) $this->cal->ant_bms_displayed_power_w : null;
    }

    /**
     * Charge current read off the Ant BMS app during the constant-current
     * phase. Unlike a power reading, current stays flat across the whole
     * CC phase, so it remains a valid comparison anchor as pack voltage
     * rises. Purely a reference — effectiveChargeCurrentA() deliberately
     * does NOT auto-prefer it; the user adopts it explicitly via the
     * settings page so the power formula stays predictable.
     */
    public function antBmsMeasuredCurrentA(): ?float
    {
        return $this->cal?->ant_bms_measured_current_a !== null ? (float) $this->cal->ant_bms_measured_current_a : null;
    }

    public function nominalVoltage(): ?float
    {
        return $this->cal?->nominal_voltage !== null ? (float) $this->cal->nominal_voltage : null;
    }

    public function nominalCapacityAh(): ?float
    {
        return $this->cal?->nominal_capacity_ah !== null ? (float) $this->cal->nominal_capacity_ah : null;
    }

    public function capacityTolerancePct(): float
    {
        return $this->cal?->capacity_tolerance_pct !== null
            ? (float) $this->cal->capacity_tolerance_pct
            : 20.0;
    }

    public function raw(): ?BatteryCalibration
    {
        return $this->cal;
    }

    public function voltageWindow(): ?array
    {
        return $this->cal?->voltageWindow();
    }
}
