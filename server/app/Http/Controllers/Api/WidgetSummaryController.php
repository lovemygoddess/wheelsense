<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Device;
use App\Models\DeviceSnapshot;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Read-only summary for the Android home-screen widget.
 *
 * The widget's AppWidgetProvider refreshes itself every ~30 min DIRECTLY
 * (no app process alive), so it cannot use session auth. It presents a
 * bearer token (WIDGET_TOKEN from .env) instead. Data comes from the
 * latest STORED snapshot (poller refreshes it every 5 min), so this
 * endpoint is cheap and never touches the upstream API.
 */
class WidgetSummaryController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $expected = (string) env('WIDGET_TOKEN', '');
        $given = (string) $request->bearerToken();
        if ($expected === '' || $given === '' || ! hash_equals($expected, $given)) {
            return ApiResponder::error(
                new ErrorObject('authentication_error', 'invalid_widget_token', 'Widget token missing or incorrect'),
                401,
            );
        }

        // The first database row can be a synthetic/test device. The widget is
        // a single-vehicle surface, so bind it to the vehicle that actually
        // produced the newest telemetry snapshot.
        $snapshot = DeviceSnapshot::query()->with('device')->latest('created_at')->first();
        $device = $snapshot?->device;
        if ($device === null) {
            return ApiResponder::error(new ErrorObject('not_found', 'no_device', '暂无设备。'), 404);
        }
        if ($snapshot === null) {
            return ApiResponder::error(new ErrorObject('not_found', 'no_snapshot', '暂无快照数据。'), 404);
        }

        // 续航（SOC × 容量 × 自学习 wh/km）与 SOC 百分比。
        // 主口径：保护板库仑 SoC（relay 实时帧，fresh 时）；回退电压法 OCV 表。
        // 返回的 soc_voltage_pct 填成"最优口径值"，原生 widget 无需改动即更准。
        $relayBms = \App\Services\Dashboard\RelayLiveBmsService::current($device->sn);
        $bmsSoc = ($relayBms !== null && $relayBms['fresh'] && $relayBms['soc_pct'] !== null)
            ? (float) $relayBms['soc_pct'] : null;
        $calibratedEndurance = null;
        $socVoltagePct = null;
        $bmsSocPct = null;
        $socSource = 'voltage';
        if ($snapshot->bms_voltage !== null) {
            $socResult = app(\App\Services\Calibration\SocEstimator::class)->estimate(
                $device->sn,
                (float) $snapshot->bms_voltage,
                $snapshot->batt_temp !== null ? (float) $snapshot->batt_temp : null,
                $snapshot->dump_energy !== null ? (float) $snapshot->dump_energy : null,
                $bmsSoc,
            );
            $calibratedEndurance = $socResult['effective_endurance_km'];
            // 原生 widget 读 soc_voltage_pct 作电量环；填最优口径值（保护板优先）。
            $socVoltagePct = $socResult['bms_soc_pct'] !== null ? $socResult['bms_soc_pct'] : $socResult['voltage_soc'];
            $bmsSocPct = $socResult['bms_soc_pct'];
            $socSource = $socResult['soc_source'];
        }

        // The widget must not keep its own "best" calculation. It consumes
        // the same primary object as the normal app, including the five-minute
        // BMS hold window and the direct-phone BMS source.
        $primary = app(\App\Services\Dashboard\PrimaryTelemetryService::class)
            ->forSnapshot($device, $snapshot);
        $primaryDiagnostics = $primary['diagnostics'];
        $socVoltagePct = $primary['soc_pct'];
        $bmsSocPct = $primaryDiagnostics['bms_usable'] ? $primaryDiagnostics['bms_soc_pct'] : null;
        $socSource = $primary['source'];
        $calibratedEndurance = $primary['range_km'];

        $relayLive = $relayBms !== null && $relayBms['fresh'];
        $relayCharging = $relayLive
            && $relayBms['current_a'] !== null
            && (float) $relayBms['current_a'] >= 0.3;
        $chargingState = app(\App\Services\Battery\ChargingStateService::class)->current($device->sn);
        $chargeActive = (bool) $chargingState['active'];
        $chargeVoltage = $relayLive && $relayBms['total_voltage_v'] !== null
            ? (float) $relayBms['total_voltage_v']
            : ($snapshot->bms_voltage !== null ? (float) $snapshot->bms_voltage : null);
        $chargeEstimate = $chargeActive && $chargeVoltage !== null
            ? app(\App\Services\Calibration\ChargeTimeEstimator::class)->estimate(
                $device->sn,
                $chargeVoltage,
                $relayLive ? now() : $snapshot->created_at,
                $relayLive ? $relayBms : null,
                $primary['soc_pct'],
                $primary['source'],
            )
            : ['supported' => false, 'reason' => '当前未在充电'];
        $remainingChargeMin = $chargeEstimate['supported']
            ? ($chargeEstimate['remaining_min'] ?? null)
            : null;

        $tpmsRaw = app(TpmsController::class)->readings();
        $freshWheel = static function (mixed $wheel): ?array {
            if (! is_array($wheel)
                || ($wheel['status'] ?? null) !== 'ok'
                || ($wheel['checksum_ok'] ?? false) !== true
                || ! is_numeric($wheel['pressure'] ?? null)
                || ! is_numeric($wheel['age_seconds'] ?? null)
                || (int) $wheel['age_seconds'] < 0
                || (int) $wheel['age_seconds'] > 300) {
                return null;
            }

            return [
                'pressure_bar' => round((float) $wheel['pressure'], 2),
                'age_seconds' => (int) $wheel['age_seconds'],
                'captured_at' => $wheel['updated_at'] ?? null,
            ];
        };

        $location = trim((string) ($snapshot->location_desc ?? ''));
        if ($location === '') {
            $location = trim((string) DeviceSnapshot::query()
                ->where('device_id', $device->id)
                ->whereNotNull('location_desc')
                ->where('location_desc', '!=', '')
                ->latest('created_at')
                ->value('location_desc'));
        }
        $locationTail = $location !== ''
            ? preg_replace('/^(?:中国)?(?:[^省]+省)?(?:[^市]+市)?(?:[^区县]+[区县])?/u', '', $location)
            : '';
        $locationTail = trim((string) $locationTail, " \t\n\r\0\x0B,，·-");
        // Prefer the concrete part after the township/street administrative
        // prefix: house number + building/POI carries much more value on a
        // small widget than a full province/city/district/street prefix. Do not truncate here;
        // Android ellipsizes the middle so the final landmark stays visible.
        $locationDetail = $location !== ''
            ? preg_replace('/^.*(?:街道|镇|乡)/u', '', $location)
            : '';
        $locationDetail = trim((string) $locationDetail, " \t\n\r\0\x0B,，·-");
        $locationShort = $location !== ''
            ? ($locationDetail !== '' ? $locationDetail : ($locationTail !== '' ? $locationTail : $location))
            : null;

        $summary = [
            'timestamp' => $snapshot->created_at?->toISOString(),
            'vehicle_name' => $device->device_name,
            // 车辆产品图：用户自传图优先，回落厂商官方透明底 PNG（devices.img）。
            // Widget 只在 URL 变化时下载一次，之后从本地缓存渲染。
            'image_url' => $device->vehicle_image
                ? asset($device->vehicle_image)
                : ($device->img ?: null),
            'location_short' => $locationShort,
            // Null means "do not render". Five minutes is inclusive and is
            // based on the BLE capture time, never on this HTTP response time.
            'tpms' => [
                'front' => $freshWheel($tpmsRaw['front'] ?? null),
                'rear' => $freshWheel($tpmsRaw['rear'] ?? null),
                'fresh_window_seconds' => 300,
            ],
            // Backward-compatible top-level field, now aligned with the one
            // canonical SOC used by the app and notification thresholds.
            'battery' => $primary['soc_pct'],
            'primary' => $primary,
            'soc_voltage_pct' => $socVoltagePct,
            'bms_soc_pct' => $bmsSocPct,
            'soc_source' => $socSource,
            'endurance' => $snapshot->estimate_mileage !== null ? (float) $snapshot->estimate_mileage : null,
            'calibrated_endurance_km' => $calibratedEndurance,
            'charging' => $chargeActive,
            'charging_started_at' => $chargingState['started_at'] ?? null,
            'charging_state' => $chargingState['state'] ?? 'idle',
            'bms_voltage' => $snapshot->bms_voltage !== null ? (float) $snapshot->bms_voltage : null,
            'batt_temp' => $snapshot->batt_temp !== null ? (float) $snapshot->batt_temp : null,
            // 有效循环数 = 用户基线 + 累计放电能量÷容量（bms_cycle_support=false，
            // 车机的 bms_cycle=9 是假值——widget 必须用这个口径，与 App 仪表板一致）。
            'effective_cycle_count' => app(\App\Services\Dashboard\VehiclePayloadMapper::class)
                ->computeEffectiveCycleCount(
                    $device,
                    \App\Models\BatteryCalibration::query()->where('device_sn', $device->sn)->first(),
                ),
            'bms_cycles' => $snapshot->bms_cycles !== null ? (float) $snapshot->bms_cycles : null,
            'bms_score' => $snapshot->bms_score !== null ? (float) $snapshot->bms_score : null,
            'lock' => $snapshot->lock_status !== null ? (float) $snapshot->lock_status : null,
            'remain_charge_time' => $remainingChargeMin,
            'charge_time_estimate' => $chargeEstimate,
            'vendor_remain_charge_time' => $snapshot->remain_charge_time,
            // Newest EZVIZ alarm, cached by PollDevicesCommand every 5 min.
            // The widget's notification chain compares its id to detect new
            // alarms without ever calling the EZVIZ API itself.
            'latest_alarm' => \Illuminate\Support\Facades\Cache::get('ezviz:latest_alarm'),
        ];

        return ApiResponder::success('summary', $summary);
    }
}
