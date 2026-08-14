<?php

namespace App\Services\Dashboard;

use App\Models\Device;
use App\Models\DeviceSnapshot;
use App\Models\BatteryCalibration;
use App\Services\Calibration\SocEstimator;
use Illuminate\Support\Carbon;

/**
 * Chooses the one energy reading that the dashboard is allowed to present as
 * its primary value.  Before this service, Home, Battery, the widget and the
 * BMS page each picked their own source and freshness window; naturally the
 * same vehicle could show several percentages and ranges at once.
 *
 * Raw values are returned in `diagnostics` for troubleshooting, but callers
 * must render `soc_pct` and `range_km` for every normal user-facing surface.
 */
class PrimaryTelemetryService
{
    public function __construct(
        private readonly SocEstimator $socEstimator,
        private readonly SocStabilizer $socStabilizer,
    ) {}

    /**
     * @return array{
     *   soc_pct: ?float,
     *   range_km: ?float,
     *   source: 'bms'|'voltage'|'vendor'|'unavailable',
     *   source_detail: ?string,
     *   updated_at: ?string,
     *   age_seconds: ?int,
     *   fresh: bool,
     *   diagnostics: array<string, mixed>
     * }
     */
    public function forSnapshot(Device $device, ?DeviceSnapshot $snapshot): array
    {
        $bmsFrame = RelayLiveBmsService::currentForDisplay($device->sn);
        $bmsSoc = null;
        if ($bmsFrame !== null && ! empty($bmsFrame['usable'])) {
            $remainingAh = isset($bmsFrame['capacity_remaining_ah']) ? (float) $bmsFrame['capacity_remaining_ah'] : null;
            $totalAh = isset($bmsFrame['capacity_total_ah']) ? (float) $bmsFrame['capacity_total_ah'] : null;
            // Prefer the board's non-rounded coulomb counter. `soc_pct` is an
            // integer on this ANT frame and can visibly bounce around the next
            // whole percentage even while remaining/total Ah is stable.
            if ($remainingAh !== null && $totalAh !== null && $totalAh > 0
                && $remainingAh >= 0 && $remainingAh <= $totalAh * 1.02) {
                $bmsSoc = max(0.0, min(100.0, $remainingAh / $totalAh * 100.0));
            } elseif ($bmsFrame['soc_pct'] !== null) {
                $bmsSoc = (float) $bmsFrame['soc_pct'];
            }
        }
        $voltage = $snapshot?->bms_voltage !== null ? (float) $snapshot->bms_voltage : null;
        $temperature = $snapshot?->batt_temp !== null ? (float) $snapshot->batt_temp : null;
        $vendorSoc = $snapshot?->dump_energy !== null ? (float) $snapshot->dump_energy : null;

        $estimate = $this->socEstimator->estimate(
            $device->sn,
            $voltage,
            $temperature,
            $vendorSoc,
            $bmsSoc,
        );

        $source = 'unavailable';
        $soc = null;
        $updatedAt = null;
        $ageSeconds = null;
        $fresh = false;
        $sourceDetail = null;
        $quality = 'unavailable';
        $confidence = 0.0;
        $degradedReason = 'no_usable_telemetry';

        if ($bmsSoc !== null) {
            $source = 'bms';
            $soc = round($bmsSoc, 1);
            $updatedAt = is_string($bmsFrame['updated_at'] ?? null) ? $bmsFrame['updated_at'] : null;
            $ageSeconds = isset($bmsFrame['age_seconds']) ? (int) $bmsFrame['age_seconds'] : null;
            $fresh = ! empty($bmsFrame['fresh']);
            $sourceDetail = ($bmsFrame['source'] ?? null) === 'phone' ? 'phone' : 'relay';
            $quality = $fresh ? 'live' : 'cached';
            $confidence = $fresh ? 1.0 : 0.9;
            $degradedReason = $fresh ? null : 'bms_transport_temporarily_stale';
        } elseif ($estimate['voltage_soc'] !== null) {
            $source = 'voltage';
            $soc = (float) $estimate['voltage_soc'];
            $updatedAt = $snapshot?->created_at?->toISOString();
            $ageSeconds = $snapshot?->created_at
                ? max(0, (int) $snapshot->created_at->diffInSeconds(Carbon::now()))
                : null;
            $fresh = $ageSeconds !== null && $ageSeconds < 600;
            $resting = (int) ($snapshot?->lock_status ?? 0) === 1;
            $quality = 'estimated';
            $confidence = $fresh ? ($resting ? 0.68 : 0.48) : 0.30;
            $degradedReason = $resting
                ? 'bms_unavailable_using_resting_voltage'
                : 'bms_unavailable_voltage_may_be_under_load';
        } elseif ($vendorSoc !== null && $vendorSoc >= 0 && $vendorSoc <= 100) {
            // Vendor SOC is a last-resort display only. It deliberately never
            // feeds the remaining-range equation for a non-stock battery.
            $source = 'vendor';
            $soc = round($vendorSoc, 1);
            $updatedAt = $snapshot?->created_at?->toISOString();
            $ageSeconds = $snapshot?->created_at
                ? max(0, (int) $snapshot->created_at->diffInSeconds(Carbon::now()))
                : null;
            $fresh = $ageSeconds !== null && $ageSeconds < 600;
            $quality = 'reference_only';
            $confidence = 0.2;
            $degradedReason = 'bms_and_voltage_unavailable_vendor_reference_only';
        }

        $stabilized = null;
        if ($soc !== null && $source === 'voltage') {
            $charging = (int) ($snapshot?->charging_state ?? 0) === 1
                || (isset($bmsFrame['current_a']) && (float) $bmsFrame['current_a'] >= 0.3);
            $current = isset($bmsFrame['current_a']) && $bmsFrame['current_a'] !== null
                ? abs((float) $bmsFrame['current_a']) : null;
            $resting = (int) ($snapshot?->lock_status ?? 0) === 1
                && ($current === null || $current < 1.0);
            $stabilized = $this->socStabilizer->stabilize(
                $device->sn,
                (float) $soc,
                $source,
                $charging,
                $resting,
                $snapshot?->created_at,
            );
            $soc = $stabilized['soc'];
            $source = $stabilized['source'];
            if ($stabilized['held']) {
                $fresh = false;
                // Source hold must also hold the matching timestamp/detail;
                // otherwise the UI could label an old BMS value with the
                // voltage snapshot's time (or vice versa).
                if ($source === 'bms' && $bmsFrame !== null) {
                    $updatedAt = is_string($bmsFrame['updated_at'] ?? null) ? $bmsFrame['updated_at'] : null;
                    $ageSeconds = isset($bmsFrame['age_seconds']) ? (int) $bmsFrame['age_seconds'] : null;
                    $sourceDetail = ($bmsFrame['source'] ?? null) === 'phone' ? 'phone' : 'relay';
                    $quality = 'cached';
                    $confidence = 0.85;
                    $degradedReason = 'holding_last_trusted_bms_value_during_source_transition';
                } elseif ($source === 'voltage') {
                    $updatedAt = $snapshot?->created_at?->toISOString();
                    $ageSeconds = $snapshot?->created_at
                        ? max(0, (int) $snapshot->created_at->diffInSeconds(Carbon::now()))
                        : null;
                    $sourceDetail = null;
                }
            }
        }

        $range = null;
        if ($soc !== null && $source !== 'vendor' && $source !== 'unavailable') {
            $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
            // A retired learning run may legitimately leave no measured Wh
            // estimate. The physical pack profile remains valid and is the
            // correct degraded-mode denominator: nominal V × configured Ah.
            // If even the profile row is unavailable, the latest valid BMS
            // frame still provides series count and configured total Ah.
            $capacityWh = $cal?->capacity_wh_estimate !== null
                ? (float) $cal->capacity_wh_estimate
                : $cal?->priorCapacityWh();
            if ($capacityWh === null && $bmsFrame !== null) {
                $totalAh = isset($bmsFrame['capacity_total_ah']) ? (float) $bmsFrame['capacity_total_ah'] : null;
                $cellCount = isset($bmsFrame['cell_count']) ? (int) $bmsFrame['cell_count'] : null;
                if ($totalAh !== null && $totalAh > 0 && $cellCount !== null && $cellCount > 0) {
                    $capacityWh = $totalAh * $cellCount * 3.7;
                }
            }
            $whPerKm = $estimate['wh_per_km'] !== null ? (float) $estimate['wh_per_km'] : null;
            if ($capacityWh !== null && $capacityWh > 0 && $whPerKm !== null && $whPerKm > 0) {
                $range = round(($soc / 100.0) * $capacityWh / $whPerKm, 1);
            }
        }

        return [
            'soc_pct' => $soc,
            // SocEstimator already uses the passed BMS SOC or voltage SOC.
            // Do not use vendor range as a fallback: it is calibrated for the
            // original pack and was the source of the 200+ km false readings.
            'range_km' => $range,
            'source' => $source,
            'source_detail' => $sourceDetail,
            'updated_at' => $updatedAt,
            'age_seconds' => $ageSeconds,
            'fresh' => $fresh,
            'quality' => $quality,
            'confidence' => round($confidence, 2),
            'degraded_reason' => $degradedReason,
            'usable_for_range' => $range !== null,
            'usable_for_safety' => $source === 'bms' && $fresh,
            'diagnostics' => [
                'bms_soc_pct' => $bmsSoc,
                'bms_age_seconds' => $bmsFrame['age_seconds'] ?? null,
                'bms_fresh' => $bmsFrame['fresh'] ?? false,
                'bms_usable' => $bmsFrame['usable'] ?? false,
                'bms_source' => $bmsFrame['source'] ?? null,
                'voltage_soc_pct' => $estimate['voltage_soc'],
                'learned_soc_pct' => $estimate['calibrated'],
                'vendor_soc_pct' => $estimate['vendor'],
                'range_wh_per_km' => $estimate['wh_per_km'],
                'range_confidence' => $estimate['confidence'],
                'range_note' => $estimate['note'],
                'soc_raw_pct' => $stabilized['raw_soc'] ?? $soc,
                'soc_raw_source' => $stabilized['raw_source'] ?? $source,
                'soc_stabilizer_held' => $stabilized['held'] ?? false,
            ],
        ];
    }
}
