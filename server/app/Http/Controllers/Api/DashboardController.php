<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\BatteryCalibration;
use App\Models\BmsLiveSnapshot;
use App\Models\ChargeEvent;
use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Models\DeviceSnapshot;
use App\Services\Calibration\ChargeTimeEstimator;
use App\Services\Battery\ChargingStateService;
use App\Services\Calibration\SocEstimator;
use App\Services\Calibration\TrustedConsumptionService;
use App\Services\Rides\BmsEnergyIntervalService;
use App\Services\Rides\VoltageRideEnergyEstimator;
use App\Services\Rides\RideEnergyAttributionService;
use App\Services\Dashboard\RideHistorySyncService;
use App\Services\Dashboard\PrimaryTelemetryService;
use App\Services\Dashboard\VehiclePayloadMapper;
use App\Services\DashboardAuth;
use App\Services\DashboardRefreshToken;
use App\Http\Middleware\LoginBruteForceGuard;
use App\Services\NinebotApiService;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

class DashboardController extends Controller
{
    // Heartbeats are periodic; a small tolerance avoids racing the next
    // scheduled report while still requiring a genuinely recent signal.
    private const RELAY_HEARTBEAT_FRESH_SEC = 360;
    public function __construct(
        private readonly NinebotApiService $ninebotApi,
        private readonly VehiclePayloadMapper $vehicleMapper,
        private readonly RideHistorySyncService $rideSync,
        private readonly PrimaryTelemetryService $primaryTelemetry,
        private readonly TrustedConsumptionService $trustedConsumption,
        private readonly BmsEnergyIntervalService $bmsEnergyIntervals,
        private readonly RideEnergyAttributionService $rideEnergy,
    ) {}

    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'account' => ['required', 'string', 'max:255'],
            'password' => ['required', 'string', 'max:255'],
        ]);
        $result = $this->ninebotApi->login($validated['account'], $validated['password']);

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'ninebot_login_failed');
        }

        Cache::forget('dashboard:ninebot:vehicles');

        return ApiResponder::success('session', is_array($result['data'] ?? null) ? $result['data'] : ['connected' => true]);
    }

    public function loginCode(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'account' => ['required', 'string', 'max:255'],
            'code' => ['nullable', 'string', 'max:12'],
        ]);
        $result = $this->ninebotApi->loginCode($validated['account'], $validated['code'] ?? null);

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'ninebot_code_login_failed');
        }

        Cache::forget('dashboard:ninebot:vehicles');

        return ApiResponder::success('session', is_array($result['data'] ?? null) ? $result['data'] : ['connected' => true]);
    }

    public function whoami(): JsonResponse
    {
        $result = $this->ninebotApi->whoami();

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'ninebot_session_missing', 401);
        }

        return ApiResponder::success('account', is_array($result['data'] ?? null) ? $result['data'] : []);
    }

    public function vehicles(): JsonResponse
    {
        // Every screen needs the vehicle identity, while the dashboard then
        // explicitly asks for a fresh snapshot. Cache this inexpensive-to-change
        // upstream list briefly so opening a tab does not multiply cloud calls.
        $cachedVehicles = Cache::get('dashboard:ninebot:vehicles');
        if (is_array($cachedVehicles)) {
            $result = ['ok' => true, 'data' => $cachedVehicles];
        } else {
            $result = $this->ninebotApi->vehicles();
            if (($result['ok'] ?? false) === true && is_array($result['data'] ?? null)) {
                Cache::put('dashboard:ninebot:vehicles', $result['data'], now()->addMinute());
            }
        }

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'vehicles_failed');
        }

        $vehicles = $this->vehicleMapper->listFromUpstream($result['data'] ?? []);
        $payload = [];

        foreach ($vehicles as $vehicle) {
            $device = Device::query()->updateOrCreate(
                ['sn' => $vehicle['sn']],
                [
                    'device_name' => $vehicle['name'],
                    'model' => $vehicle['model'],
                    'img' => $vehicle['image_url'],
                    'raw' => $vehicle['raw'],
                ],
            );
            // A fresh status+battery read belongs to /snapshot. Returning the
            // most recent persisted snapshot here avoids a hidden N×2 cloud
            // request on every page open; bootstrap only when no data exists.
            $snapshot = $device->snapshots()->latest('id')->first();
            if ($snapshot === null) {
                $snapshot = $this->vehicleMapper->collectSnapshot($device);
            }
            $payload[] = $this->vehicleMapper->mapDevice($device, $snapshot);
        }

        return ApiResponder::collection('vehicles', $payload);
    }

    public function snapshot(string $sn): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();

        if ($device === null) {
            return $this->notFound();
        }

        $snapshot = $this->vehicleMapper->collectSnapshot($device);

        if ($snapshot === null) {
            return ApiResponder::error(new ErrorObject('upstream_error', 'snapshot_failed', '无法读取车辆实时状态。'), 422);
        }

        $payload = $this->vehicleMapper->mapSnapshot($snapshot);
        // SOC：保护板库仑 SoC（relay 实时帧）为主口径，电压法 OCV 表为回退。
        // relay 实时帧可用（fresh）时传入 soc_pct，SocEstimator 将其作为电量环
        // 主口径；bms_soc_pct / soc_source 告诉前端当前用哪个口径。
        $relayBms = \App\Services\Dashboard\RelayLiveBmsService::current($device->sn);
        $bmsSoc = ($relayBms !== null && $relayBms['fresh'] && $relayBms['soc_pct'] !== null)
            ? (float) $relayBms['soc_pct'] : null;
        $payload['calibrated_endurance_km'] = null;
        $payload['soc_voltage_pct'] = null;
        $payload['soc_calibrated_pct'] = null;
        $payload['bms_soc_pct'] = null;
        $payload['soc_source'] = 'voltage';
        if ($payload['bms_voltage'] !== null) {
            $socResult = app(SocEstimator::class)->estimate(
                $device->sn,
                (float) $payload['bms_voltage'],
                $payload['batt_temp'] !== null ? (float) $payload['batt_temp'] : null,
                $payload['battery'] !== null ? (float) $payload['battery'] : null,
                $bmsSoc,
            );
            $payload['calibrated_endurance_km'] = $socResult['effective_endurance_km'];
            $payload['soc_voltage_pct'] = $socResult['voltage_soc'];
            $payload['soc_calibrated_pct'] = $socResult['calibrated'];
            $payload['bms_soc_pct'] = $socResult['bms_soc_pct'];
            $payload['soc_source'] = $socResult['soc_source'];
        }
        // One primary contract for Home, Battery and the widget. Legacy fields
        // stay as aliases/diagnostics for one APK release only.
        $primary = $this->primaryTelemetry->forSnapshot($device, $snapshot);
        $diagnostics = $primary['diagnostics'];
        $payload['primary'] = $primary;
        $payload['calibrated_endurance_km'] = $primary['range_km'];
        $payload['soc_voltage_pct'] = $diagnostics['voltage_soc_pct'];
        $payload['soc_calibrated_pct'] = $diagnostics['learned_soc_pct'];
        $payload['bms_soc_pct'] = $diagnostics['bms_usable'] ? $diagnostics['bms_soc_pct'] : null;
        $payload['soc_source'] = $primary['source'];

        // Keep every surface on one charge-time contract. NineCLI currently
        // reports 00:10 while the live board still has multiple Ah to accept,
        // so retain it only as a diagnostic and publish the board-based result.
        $payload['vendor_remain_charge_time'] = $payload['remain_charge_time'];
        $relayLive = $relayBms !== null && $relayBms['fresh'];
        $chargingState = app(ChargingStateService::class)->current($device->sn);
        $chargeActive = (bool) $chargingState['active'];
        $chargeVoltage = $relayLive && $relayBms['total_voltage_v'] !== null
            ? (float) $relayBms['total_voltage_v']
            : ($payload['bms_voltage'] !== null ? (float) $payload['bms_voltage'] : null);
        $chargeEstimate = $chargeActive && $chargeVoltage !== null
            ? app(ChargeTimeEstimator::class)->estimate(
                $device->sn,
                $chargeVoltage,
                $relayLive ? Carbon::now() : $snapshot->created_at,
                $relayLive ? $relayBms : null,
                $primary['soc_pct'],
                $primary['source'],
            )
            : ['supported' => false, 'reason' => '当前未在充电'];
        $payload['charging'] = $chargeActive;
        $payload['charging_started_at'] = $chargingState['started_at'] ?? null;
        $payload['charging_state_source'] = $chargingState['source'] ?? null;
        $payload['charging_state'] = $chargingState['state'] ?? 'idle';
        $payload['charge_time_estimate'] = $chargeEstimate;
        $payload['remain_charge_time'] = $chargeEstimate['supported']
            ? ($chargeEstimate['remaining_min'] ?? null)
            : null;

        // Hand the widget bearer token to the (gated) app so it can forward it
        // into the widget provider's SharedPreferences. Only session-unlocked
        // clients ever see this value.
        $payload['widget_token'] = (string) env('WIDGET_TOKEN', '') ?: null;

        return ApiResponder::success('snapshot', $payload);
    }

    public function history(Request $request, string $sn): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();

        if ($device === null) {
            return $this->notFound();
        }

        $hours = max(1, min((int) $request->query('hours', 24), 168));
        $rows = $device->snapshots()
            ->where('created_at', '>=', Carbon::now()->subHours($hours))
            ->orderBy('created_at')
            ->get();

        return ApiResponder::collection('history', $rows->map(fn (DeviceSnapshot $snapshot): array => [
            'timestamp' => $snapshot->created_at->toISOString(),
            'battery' => $snapshot->dump_energy,
            'mileage' => $snapshot->estimate_mileage,
            'charging' => $snapshot->charging_state === 1,
            'charging_power' => $snapshot->charging_power,
            'bms_voltage' => $snapshot->bms_voltage,
            'batt_temp' => $snapshot->batt_temp,
        ])->all());
    }

    public function rides(Request $request, string $sn): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();

        if ($device === null) {
            return $this->notFound();
        }

        $month = (string) $request->query('month', Carbon::now()->format('Ym'));
        $result = $this->ninebotApi->travel($sn, $month);

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'rides_failed');
        }

        $data = is_array($result['data'] ?? null) ? $result['data'] : [];
        $upstreamList = is_array($data['list'] ?? null) ? $data['list'] : [];

        $stored = $this->rideSync->syncMonth($device, $month, $upstreamList);
        $stored = $this->rideEnergy->attributeMonth($device, $month);
        // Same response carries the authoritative monthly aggregates used by
        // the odometer / cycle-count computations.
        $this->rideSync->syncMonthSummary($device, $month, $data);

        // Ninebot travel is used only for trip identity/time/distance. Its
        // energy/ec fields are never read below. Consumption comes from local
        // BMS coulomb integration, voltage attribution, or their trusted mean.
        $trusted = $this->trustedConsumption->estimate($device->sn);
        $trustedWhPerKm = $trusted['wh_per_km'];
        $monthStart = Carbon::createFromFormat('!Ym', $month)->startOfMonth();
        $voltageEstimator = VoltageRideEnergyEstimator::load(
            $device->id,
            $monthStart,
            $monthStart->copy()->endOfMonth(),
        );
        $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
        $capacityWh = $cal?->capacity_wh_estimate !== null
            ? (float) $cal->capacity_wh_estimate
            : (($cal?->nominal_voltage !== null && $cal?->nominal_capacity_ah !== null)
                ? (float) $cal->nominal_voltage * (float) $cal->nominal_capacity_ah
                : VoltageRideEnergyEstimator::FALLBACK_CAPACITY_WH);

        $deviceSn = $device->sn;
        $ridePayload = $stored->map(function (DeviceRideHistory $ride) use ($trustedWhPerKm, $deviceSn, $voltageEstimator, $capacityWh): array {
            $mileage = (float) $ride->mileage;
            $integrated = $this->bmsEnergyIntervals->energyForWindow($deviceSn, $ride->started_at, $ride->ended_at);
            $integratedWhPerKm = $integrated['energy_wh'] !== null && $mileage > 0
                ? $integrated['energy_wh'] / $mileage
                : null;
            // Short trips amplify clock/boundary noise, while an implausible
            // Wh/km means the relay window was not the same physical ride even
            // if its timestamps overlap. Fall back to the trusted long-term
            // estimate instead of displaying a precise-looking bad number.
            $lowerWhPerKm = $trustedWhPerKm !== null ? max(15.0, $trustedWhPerKm * 0.50) : 15.0;
            $upperWhPerKm = $trustedWhPerKm !== null ? min(90.0, $trustedWhPerKm * 1.80) : 90.0;
            $integratedIsUsable = $mileage >= 2.0
                && $integratedWhPerKm !== null
                && $integratedWhPerKm >= $lowerWhPerKm
                && $integratedWhPerKm <= $upperWhPerKm;
            if ($integratedIsUsable) {
                $energy = [
                    'energy_wh' => $integrated['energy_wh'],
                    'wh_per_km' => round($integratedWhPerKm, 2),
                    'source' => 'bms_interval',
                ];
            } else {
                $voltage = $voltageEstimator->estimate(
                    $ride->started_at,
                    $ride->ended_at,
                    $capacityWh,
                );
                $energy = $voltage !== null
                    ? [
                        'energy_wh' => $voltage['energy_wh'],
                        'wh_per_km' => $mileage > 0 ? round($voltage['energy_wh'] / $mileage, 2) : null,
                        'source' => $voltage['source'],
                    ]
                    : $this->trustedConsumption->fallbackForRide($mileage, $trustedWhPerKm);
            }

            $ride->forceFill([
                'energy' => $energy['energy_wh'] ?? 0,
                'energy_source' => $energy['source'],
                'energy_coverage' => $integrated['coverage'],
                'wh_per_km' => $energy['wh_per_km'],
            ])->save();
            return [
            'id' => $ride->ride_id,
            'started_at' => $ride->started_at?->toISOString(),
            'ended_at' => $ride->ended_at?->toISOString(),
            'mileage' => $mileage,
            'energy' => $energy['energy_wh'],
            'energy_source' => $energy['source'],
            'wh_per_km' => $energy['wh_per_km'],
            'energy_coverage' => $integrated['coverage'],
            // Average = mileage ÷ wall-clock duration, computed locally.
            // list[].speed is NOT an average (it is the ride's peak), so it
            // is deliberately not used as a fallback here.
            'avg_speed_kph' => $this->rideSync->resolveAvgSpeedKph($ride),
            // Peak: trail multi-peak analysis first (implausible short-ride
            // GPS ceilings filtered out), then the vendor's own per-ride
            // peak so rows without trail analysis still carry a figure.
            'max_speed_kph' => self::filterImplausibleSpeed($ride->max_speed_kph, $ride->mileage)
                ?? $this->rideSync->vendorPeakSpeedKph($ride),
            ];
        });

        $monthMileage = (float) ($data['total_mileages'] ?? $stored->sum('mileage'));
        $knownRideEnergy = $ridePayload->pluck('energy')->filter(static fn ($value): bool => is_numeric($value));
        $monthEnergy = $knownRideEnergy->isNotEmpty() ? round((float) $knownRideEnergy->sum(), 1) : null;
        $trusted = $this->trustedConsumption->estimate($device->sn);
        $trustedWhPerKm = $trusted['wh_per_km'];

        return ApiResponder::collection('rides', $ridePayload->all(), meta: [
            'month' => $month,
            'month_mileage' => $monthMileage,
            'month_energy' => $monthEnergy,
            'month_duration' => (int) ($data['duration'] ?? 0),
            'month_ride_count' => (int) ($data['times'] ?? $stored->count()),
            // data.detail is a 31-element array of per-day km (newest-first).
            // The chart consumes it directly — no client-side accumulation needed.
            'month_daily' => is_array($data['detail'] ?? null)
                ? array_map(static fn ($v): float => (float) $v, $data['detail'])
                : null,
            'wh_per_km_learned' => $trustedWhPerKm,
            'wh_per_km_learned_samples' => $trusted['sample_count'],
            'wh_per_km_source' => $trusted['source'],
        ]);
    }

    /**
     * GET /api/dashboard/vehicles/{sn}/rides/{rideId}/trail
     *
     * Fetches the per-ride GPS trail from the upstream Ninebot API and
     * returns a parsed speed time-series plus the multi-peak top-speed
     * analysis.  The trail is NOT stored locally — it's fetched on-demand
     * because each ride is ~14KB and only needed when the user opens the
     * ride detail modal.
     */
    public function rideTrail(string $sn, string $rideId): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();
        if ($device === null) {
            return $this->notFound();
        }

        $ride = $device->rideHistory()->where('ride_id', $rideId)->first();
        if ($ride === null) {
            return $this->notFound();
        }

        // The local ride_id is a synthetic key (e.g. "202606-UUID").
        // The upstream detail endpoint needs the real travel_id UUID
        // stored in payload.travel_id.
        $upstreamId = is_array($ride->payload) ? ($ride->payload['travel_id'] ?? null) : null;
        if (! $upstreamId) {
            return ApiResponder::error(new ErrorObject(
                'invalid_request_error',
                'no_travel_id',
                '该骑行记录缺少上游 travel_id，无法获取轨迹。',
            ), 422);
        }

        $result = $this->ninebotApi->travelDetail($sn, (string) $upstreamId);

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'trail_failed');
        }

        $data = is_array($result['data'] ?? null) ? $result['data'] : [];
        $trail = (string) ($data['trail'] ?? '');

        if ($trail === '') {
            return ApiResponder::error(new ErrorObject(
                'upstream_error',
                'no_trail',
                '上游返回的轨迹数据为空。',
            ), 422);
        }

        $apiAvgSpeed = isset($data['speed']) ? (float) $data['speed'] : null;
        $analyzer = new \App\Services\SpeedAnalyzer();
        $analysis = $analyzer->analyse($trail, $apiAvgSpeed, (float) $ride->mileage);

        // If the multi-peak analysis found a confident top speed, also
        // persist it to the ride row so the rides() list doesn't need to
        // re-fetch every trail. Only overwrite when the new method is
        // multi_peak (more reliable) or when the existing value is null.
        if (
            $analysis['top_speed_method'] === 'multi_peak'
            && $analysis['top_speed_kph'] !== null
            && ($ride->max_speed_kph === null || (float) $ride->max_speed_kph !== (float) $analysis['top_speed_kph'])
        ) {
            $ride->max_speed_kph = $analysis['top_speed_kph'];
            $ride->save();
        }

        return ApiResponder::success('trail', [
            'ride_id' => $rideId,
            'point_count' => $analysis['point_count'],
            'duration_sec' => $analysis['duration_sec'],
            'speed_series' => $analysis['speed_series'],
            'top_speed_kph' => $analysis['top_speed_kph'],
            'top_speed_method' => $analysis['top_speed_method'],
            'top_speed_peaks' => $analysis['top_speed_peaks'],
            'top_speed_note' => $analysis['top_speed_note'],
        ]);
    }

    public function command(Request $request, string $sn, string $action): JsonResponse
    {
        if (! filter_var(env('ENABLE_NINEBOT_REMOTE_CONTROL', false), FILTER_VALIDATE_BOOL)) {
            return ApiResponder::error(
                new ErrorObject('permission_error', 'ninebot_remote_control_disabled', 'Vehicle control is disabled for this deployment.'),
                403,
            );
        }

        if (! $request->boolean('confirmed')) {
            return ApiResponder::error(new ErrorObject('invalid_request_error', 'confirmation_required', '请确认后再执行车辆控制。'), 409);
        }

        if (! Device::query()->where('sn', $sn)->exists()) {
            return $this->notFound();
        }

        $result = $this->ninebotApi->command($sn, $action);

        if (($result['ok'] ?? false) !== true) {
            return $this->upstreamError($result, 'command_failed');
        }

        return ApiResponder::success('command', is_array($result['data'] ?? null) ? $result['data'] : ['success' => true]);
    }

    /**
     * Battery-focused overview: latest snapshot, recent charge events, calibration state,
     * recent voltage points (last N hours). Powers the /battery SPA tab.
     *
     * Optional: ?sn={serial} to scope to one device (defaults to first device).
     *           ?hours=24 (default) for voltage window width.
     */
    public function batteryOverview(Request $request): JsonResponse
    {
        $sn = $request->query('sn');
        $hours = max(1, min((int) $request->query('hours', 24), 168));

        if (is_string($sn) && $sn !== '') {
            $device = Device::query()->where('sn', $sn)->first();
        } else {
            $device = Device::query()->orderBy('id')->first();
        }

        if ($device === null) {
            return ApiResponder::error(
                new ErrorObject('not_found', 'no_device', '暂未发现已绑定车辆。'),
                404
            );
        }

        // Latest snapshot
        $latest = $device->snapshots()->latest()->first();
        $latestPayload = $latest ? $this->vehicleMapper->mapSnapshot($latest) : null;

        // Last 10 charge events (most recent first)
        $events = ChargeEvent::query()
            ->where('device_sn', $device->sn)
            ->orderByDesc('started_at')
            ->limit(10)
            ->get()
            ->map(fn (ChargeEvent $e) => [
                'id' => $e->id,
                'started_at' => $e->started_at?->toISOString(),
                'ended_at' => $e->ended_at?->toISOString(),
                'start_voltage' => $e->start_voltage,
                'end_voltage' => $e->end_voltage,
                'peak_voltage' => $e->peak_voltage,
                'avg_temp' => $e->avg_temp,
                'is_full_charge' => (bool) $e->is_full_charge,
                'detection_method' => $e->detection_method,
            ])
            ->all();

        // Calibration row (might not exist yet)
        $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
        $trustedConsumption = $this->trustedConsumption->estimate($device->sn);

        // Lifetime peak speed from backfilled trail data. null until the
        // backfill command processes at least one ride. We compute on the
        // fly rather than caching in battery_calibration so the value is
        // always fresh and doesn't need its own invalidation.
        $historicalMaxSpeed = (float) \App\Models\DeviceRideHistory::query()
            ->where('device_id', $device->id)
            ->whereNotNull('max_speed_kph')
            ->max('max_speed_kph');

        // Effective cycle count (shared computation)
        $effectiveCycleCount = $this->vehicleMapper->computeEffectiveCycleCount($device, $cal);

        // Lifetime consumption uses synced distance × BMS/voltage Wh/km.
        // The upstream monthly EC field is intentionally ignored.
        $totalRideKm = (float) \App\Models\DeviceRideMonthSummary::query()
            ->where('device_id', $device->id)
            ->sum('total_mileage_km');
        $totalDischargeWh = $trustedConsumption['wh_per_km'] !== null
            ? round($totalRideKm * $trustedConsumption['wh_per_km'], 1)
            : null;

        $calPayload = $cal ? [
            'is_calibrated' => (bool) $cal->is_calibrated,
            'capacity_wh_estimate' => $cal->capacity_wh_estimate,
            'wh_per_km_current' => $trustedConsumption['wh_per_km'],
            'wh_per_km_slope' => null,
            'soc_curve_version' => (int) $cal->soc_curve_version,
            'total_calibration_samples' => $trustedConsumption['sample_count'],
            'confidence_soc' => (float) $cal->confidence_soc,
            'confidence_consumption' => min(1.0, $trustedConsumption['sample_count'] / 20.0),
            'last_calibrated_at' => $cal->last_calibrated_at?->toISOString(),
            'chemistry_type' => $cal->chemistry_type,
            'cell_series_count' => $cal->cell_series_count,
            'bms_full_charge_voltage' => $cal->bms_full_charge_voltage,
            'bms_cutoff_voltage' => $cal->bms_cutoff_voltage,
            'nominal_voltage' => $cal->nominal_voltage,
            'nominal_capacity_ah' => $cal->nominal_capacity_ah,
            'capacity_tolerance_pct' => $cal->capacity_tolerance_pct,
            'priors_updated_at' => $cal->priors_updated_at?->toISOString(),
            // Lifetime peak speed from backfilled trail data. null until
            // the backfill command processes at least one ride.
            'historical_max_speed_kph' => $historicalMaxSpeed > 0 ? $historicalMaxSpeed : null,
            // Effective cycle count computed from baseline + cumulative discharge.
            'effective_cycle_count' => $effectiveCycleCount,
            'total_discharge_wh' => $totalDischargeWh !== null && $totalDischargeWh > 0 ? $totalDischargeWh : null,
        ] : null;

        // Voltage history points (last N hours) — one per minute_bucket
        $since = Carbon::now()->subHours($hours);
        $voltageSeries = DeviceSnapshot::query()
            ->where('device_id', $device->id)
            ->where('created_at', '>=', $since)
            ->whereNotNull('bms_voltage')
            ->orderBy('created_at')
            ->get(['created_at', 'bms_voltage', 'charging_state', 'batt_temp'])
            ->map(fn (DeviceSnapshot $s) => [
                'timestamp' => $s->created_at->toISOString(),
                'voltage' => $s->bms_voltage !== null ? (float) $s->bms_voltage : null,
                'charging' => (int) $s->charging_state === 1,
                'temp' => $s->batt_temp !== null ? (float) $s->batt_temp : null,
            ])
            ->all();

        // --- Estimations: range, charge time, charge power
        $socEstimator = app(SocEstimator::class);
        $chargeTimeEstimator = app(ChargeTimeEstimator::class);

        // Relay live BMS frame（保护板实时帧）需先拉取：SOC 主口径与
        // charge 口径都依赖它。$relayLive 用于标记实时板数据是否可用。
        $relayBms = $this->relayLiveBms($device->sn);
        $relayLive = $relayBms !== null && $relayBms['fresh'];

        // 保护板库仑 SoC（relay 实时帧）为主口径：从刚拉取的 $relayBms 取。
        $bmsSoc = ($relayBms !== null && $relayBms['fresh'] && $relayBms['soc_pct'] !== null)
            ? (float) $relayBms['soc_pct'] : null;
        $socResult = $latest && $latest->bms_voltage !== null
            ? $socEstimator->estimate(
                $device->sn,
                (float) $latest->bms_voltage,
                $latest->batt_temp !== null ? (float) $latest->batt_temp : null,
                // `dump_energy` is the vendor's displayed SOC field on the
                // stored snapshot. There is no `battery` column; using it
                // silently discarded the final fallback value.
                $latest->dump_energy !== null ? (float) $latest->dump_energy : null,
                $bmsSoc,
            )
            : [
                'calibrated' => null,
                'voltage_soc' => null,
                'bms_soc_pct' => null,
                'soc_source' => 'voltage',
                'vendor' => null,
                'confidence' => 0.0,
                'sample_count' => 0,
                'curve_version' => 0,
                'effective_endurance_km' => null,
                'wh_per_km' => null,
                'note' => '尚无电压数据',
            ];

        // Do not let this endpoint choose a second SOC/range source. Its
        // diagnostics retain every raw figure, while `primary` is identical to
        // the snapshot and widget contracts.
        $primary = $this->primaryTelemetry->forSnapshot($device, $latest);
        $primaryDiagnostics = $primary['diagnostics'];
        $socResult['effective_endurance_km'] = $primary['range_km'];
        $socResult['calibrated'] = $primaryDiagnostics['learned_soc_pct'];
        $socResult['voltage_soc'] = $primaryDiagnostics['voltage_soc_pct'];
        $socResult['bms_soc_pct'] = $primaryDiagnostics['bms_usable']
            ? $primaryDiagnostics['bms_soc_pct']
            : null;
        $socResult['soc_source'] = $primary['source'];
        $socResult['vendor'] = $primaryDiagnostics['vendor_soc_pct'];
        $socResult['wh_per_km'] = $primaryDiagnostics['range_wh_per_km'];
        $socResult['confidence'] = $primaryDiagnostics['range_confidence'];
        $socResult['note'] = $primaryDiagnostics['range_note'];
        if ($latestPayload !== null) {
            $latestPayload['primary'] = $primary;
        }

        $voltageForCharge = $relayLive && $relayBms['total_voltage_v'] !== null
            ? (float) $relayBms['total_voltage_v']
            : ($latest && $latest->bms_voltage !== null ? (float) $latest->bms_voltage : null);
        $relayCharging = $relayLive
            && $relayBms['current_a'] !== null
            && (float) $relayBms['current_a'] >= 0.3;
        $isCharging = $relayCharging || ($latest !== null && (int) $latest->charging_state === 1);
        $chargeEstimate = $voltageForCharge !== null
            ? $chargeTimeEstimator->estimate(
                $device->sn,
                $voltageForCharge,
                $relayLive ? Carbon::now() : ($latest?->created_at ?? Carbon::now()),
                $relayLive ? $relayBms : null,
                $primary['soc_pct'],
                $primary['source'],
            )
            : ['supported' => false, 'reason' => '尚无电压数据'];

        // Charge power = V × effective_charge_current. The effective current
        // prefers the configured charger_output_current_a (the physical charger's
        // real output) over the BMS spec max_charge_current_a — a adjustable
        // charger's actual output is far more accurate for reporting wattage.
        $settings = new \App\Services\Calibration\CalibrationSettings($cal);
        $effI = $settings->effectiveChargeCurrentA();
        $powerW = $relayCharging && $relayBms['power_w'] !== null
            ? round(abs((float) $relayBms['power_w']), 1)
            : (($voltageForCharge !== null && $effI !== null && $isCharging)
                ? round($voltageForCharge * $effI, 1)
                : null);

        // When the user has entered a one-shot Ant BMS displayed power reading,
        // surface the deviation between our estimate and that ground-truth so
        // they can dial in charger_output_current_a until the gap closes.
        $antBmsPower = $settings->antBmsDisplayedPowerW();
        $powerDeviationPct = null;
        if ($powerW !== null && $antBmsPower !== null && $antBmsPower > 0) {
            $powerDeviationPct = round(($powerW - $antBmsPower) / $antBmsPower * 100, 2);
        }

        // Current-口径 comparison: the Ant BMS measured current is a stable
        // anchor across the whole CC phase (unlike a power reading, it does
        // not drift as pack voltage rises). Deviation is relative to the
        // same effective current the power formula uses.
        $antBmsCurrent = $settings->antBmsMeasuredCurrentA();
        $currentDeviationPct = null;
        if ($effI !== null && $antBmsCurrent !== null && $antBmsCurrent > 0) {
            $currentDeviationPct = round(($effI - $antBmsCurrent) / $antBmsCurrent * 100, 2);
        }

        // Relay live BMS override: when the relay is streaming a real board
        // frame right now, the dashboard prefers its measured current/power/
        // voltage over the estimate. The estimate (and its deviation vs the
        // user-entered Ant values) is preserved for reference/comparison.
        // ($relayBms / $relayLive 已在上方 SOC 估算前拉取。)

        return ApiResponder::success('overview', [
            'device' => [
                'sn' => $device->sn,
                'name' => $device->device_name,
                'model' => $device->model,
            ],
            'latest' => $latestPayload,
            'latest_at' => $latest?->created_at?->toISOString(),
            'primary' => $primary,
            'is_charging' => $isCharging,
            'range_estimate' => [
                'effective_endurance_km' => $socResult['effective_endurance_km'],
                'calibrated_soc_pct' => $socResult['calibrated'],
                'soc_voltage_pct' => $socResult['voltage_soc'],
                'bms_soc_pct' => $socResult['bms_soc_pct'],
                'soc_source' => $socResult['soc_source'],
                'vendor_soc_pct' => $socResult['vendor'],
                'wh_per_km' => $socResult['wh_per_km'],
                'confidence' => $socResult['confidence'],
                'note' => $socResult['note'],
            ],
            'charge_time_estimate' => $chargeEstimate,
            'charge_power_w' => $powerW,
            'ant_bms_displayed_power_w' => $antBmsPower,
            'charge_power_deviation_pct' => $powerDeviationPct,
            'ant_bms_measured_current_a' => $antBmsCurrent,
            'charge_current_effective_a' => $effI,
            'charge_current_deviation_pct' => $currentDeviationPct,
            'relay' => $relayBms,
            'charge_source' => $relayLive ? 'relay_live' : 'estimate',
            'charge_events' => $events,
            'calibration' => $calPayload,
            'voltage_series' => $voltageSeries,
            'window_hours' => $hours,
            'generated_at' => Carbon::now()->toISOString(),
        ]);
    }

    public function mapConfig(): JsonResponse
    {
        return ApiResponder::success('config', [
            'amap_key' => (string) env('AMAP_KEY', ''),
        ]);
    }

    /**
     * GET /api/map/static?lng=&lat=&zoom=&w=&h=&scale=
     *
     * 高德静态图的服务端代理。手机无法直连 restapi.amap.com：
     *  ① 高德 Web 服务 key 绑定了本服务器 IP 白名单，手机换公网 IP 就被拒；
     *  ② RN 的 <Image> 不会带仪表盘会话 cookie。
     * 这里由服务器（白名单 IP、且持有 key）去高德拉 PNG 并流式返回，
     * 手机只跟我们自己的源通信。坐标已是 GCJ-02（App 在调用前做了 WGS84→GCJ02）。
     * 鉴权走普通仪表盘会话（客户端用带 cookie 的 fetch 取图）。
     */
    public function mapStatic(Request $request): Response
    {
        $key = (string) env('AMAP_KEY', '');
        if ($key === '') {
            return response()->json(['error' => 'map not configured'], 503);
        }
        $lng = $request->query('lng');
        $lat = $request->query('lat');
        if (! is_numeric($lng) || ! is_numeric($lat)) {
            return response()->json(['error' => 'bad coordinates'], 400);
        }
        $lng = (float) $lng;
        $lat = (float) $lat;
        $zoom = max(1, min(19, (int) $request->query('zoom', 15)));
        $w = max(50, min(1024, (int) $request->query('w', 400)));
        $h = max(50, min(1024, (int) $request->query('h', 240)));
        $scale = in_array((int) $request->query('scale', 2), [1, 2], true) ? (int) $request->query('scale', 2) : 2;

        $url = 'https://restapi.amap.com/v3/staticmap?key=' . urlencode($key)
            . '&location=' . $lng . ',' . $lat
            . '&zoom=' . $zoom
            . '&size=' . $w . '*' . $h
            . '&scale=' . $scale
            . '&markers=mid,,A:' . $lng . ',' . $lat;

        try {
            $resp = Http::timeout(8)->get($url);
        } catch (\Throwable $e) {
            return response()->json(['error' => 'map fetch failed'], 502);
        }

        $ct = $resp->header('Content-Type') ?: 'image/png';
        if ($resp->status() !== 200 || stripos($ct, 'image/') === false) {
            return response()->json(['error' => 'map unavailable'], 502);
        }

        return response($resp->body(), 200)
            ->header('Content-Type', $ct)
            ->header('Cache-Control', 'public, max-age=3600');
    }

    /**
     * GET /api/dashboard/bms-relay/status?sn={serial}
     *
     * Returns the BMS relay phone's own battery health + connection status,
     * sourced from the latest BMS-live-snapshot row the relay APK posted.
     *
     * The relay injects its phone_battery_* fields into every parsed frame and
     * posts on each board poll (~once per 2s). So a recent row means: the relay
     * phone is alive AND was connected to the ANT board at that moment. We derive
     * two flags from it:
     *   - connected:      last report within 5 min (relay phone reachable)
     *   - board_connected: that latest row carried a real BMS frame (board was
     *                     attached when it reported)
     * If the relay never reported for this device, present=false.
     */
    public function relayStatus(Request $request): JsonResponse
    {
        $sn = (string) $request->query('sn', '');
        if ($sn === '') {
            $sn = (string) Device::query()->orderBy('id')->value('sn');
        }

        $device = Device::where('sn', $sn)->first();
        $pollMs = $device !== null ? (int) ($device->relay_poll_ms ?? 5000) : 5000;

        // 动态上行间隔：仪表板按「GPS 启用 + 骑行中」驱动中继推送保护板帧的节奏。
        // 仅当新版本仪表板显式上报 gps_active 时才介入；旧版本不报则保留原值，
        // 避免把仍在骑行的设备误降速。仅在目标值变化时才落库，省掉每拍写盘。
        // 激进：1000ms（GPS 开 + 骑行中）／ 缓慢：5000ms（其余）。
        if ($device !== null && $request->has('gps_active')) {
            $gpsActive = $request->query('gps_active') === '1' || $request->query('gps_active') === 'true';
            $riding = $request->query('riding') === '1' || $request->query('riding') === 'true';
            $targetUploadMs = ($gpsActive && $riding) ? 1000 : 5000;
            if (($device->relay_upload_ms ?? 3000) !== $targetUploadMs) {
                $device->relay_upload_ms = $targetUploadMs;
                $device->save();
            }
        }

        // Liveness + phone status come from the rolling heartbeat row only.
        // ->live() excludes backfilled rows, and is_heartbeat = 1 is relay-
        // exclusive: the dashboard phone never sends heartbeats, only board
        // frames. Reading "is the relay online" off any live row let the
        // dashboard phone's own board reads fake an online relay; the heartbeat
        // row cannot. (created_at, not captured_at, is still the clock — the
        // relay reports UTC while the server runs Asia/Shanghai.)
        $heartbeat = BmsLiveSnapshot::query()
            ->live()
            ->where('device_sn', $sn)
            ->where('is_heartbeat', true)
            ->orderByDesc('created_at')
            ->first();

        $relayBms = $this->relayLiveBms($sn);
        $ambient = $this->relayAmbient($sn);

        if ($heartbeat === null) {
            return ApiResponder::success('relay', [
                'present' => false,
                'device_sn' => $sn,
                'connected' => false,
                'board_connected' => false,
                'board_fresh' => false,
                'board_state' => 'unavailable',
                'board_frame_age_seconds' => null,
                'board_link_age_seconds' => null,
                'bms' => null,
                'ble_status' => null,
                'phone_battery_level_pct' => null,
                'phone_battery_temp_c' => null,
                'phone_charging' => null,
                'phone_battery_voltage_v' => null,
                'phone_screen_on' => null,
                'last_report_at' => null,
                'age_seconds' => null,
                'ambient' => $ambient,
                'poll_ms' => $pollMs,
                'app_ver' => null,
                'version_code' => null,
                'version_code_source' => 'unknown',
            ]);
        }

        // Freshness is measured by SERVER receive time (created_at), NOT the
        // relay's captured_at: the relay reports UTC while the server runs in
        // Asia/Shanghai, so trusting captured_at made every report look ~8h
        // stale and forced the dashboard to show "offline".
        $ageSeconds = max(0, (int) $heartbeat->created_at->diffInSeconds(now()));
        // A fresh relay-only board frame is also a hard liveness signal: it was
        // decoded and POSTed by the relay process moments ago. Android can miss a
        // validated-network callback, which used to suppress heartbeat rows
        // even while forced board uploads succeeded. Never show "relay
        // offline" beside a current relay frame.
        $connected = $ageSeconds < self::RELAY_HEARTBEAT_FRESH_SEC
            || ($relayBms !== null && $relayBms['fresh']);
        // Board attachment: trust the relay's heartbeat flag, but a fresh relay
        // board frame also proves it (covers the gap before the next heartbeat).
        $boardConnected = ($heartbeat->board_connected ?? false)
            || ($relayBms !== null && $relayBms['fresh']);
        // One explicit state machine for every screen. `board_connected` is a
        // physical-link observation from the relay heartbeat; `board_fresh`
        // means a new measured board frame actually reached this server. They
        // are both useful, but neither may silently pretend to be the other.
        $boardState = ! $connected
            ? 'relay_offline'
            : ($relayBms !== null && $relayBms['fresh']
                ? 'live'
                : ($boardConnected ? 'connected_stale' : 'disconnected'));

        $level = $heartbeat->phone_battery_level_pct;
        $temp = $heartbeat->phone_battery_temp_c;
        $volt = $heartbeat->phone_battery_voltage_v;
        $charging = $heartbeat->phone_charging;
        $screenOn = $heartbeat->phone_screen_on;

        $appVersion = $heartbeat->app_ver ?? null;
        $versionMap = (array) config('relay.version_code_map', []);
        $versionCode = $appVersion !== null && array_key_exists((string) $appVersion, $versionMap)
            ? (int) $versionMap[(string) $appVersion]
            : null;

        return ApiResponder::success('relay', [
            'present' => true,
            'device_sn' => $sn,
            'connected' => $connected,
            'board_connected' => $boardConnected,
            'board_fresh' => $relayBms !== null && $relayBms['fresh'],
            'board_state' => $boardState,
            'board_frame_age_seconds' => $relayBms['age_seconds'] ?? null,
            'board_link_age_seconds' => $ageSeconds,
            'ble_status' => $heartbeat->ble_status ?? null,
            'bms' => $relayBms,
            'phone_battery_level_pct' => $level !== null ? (float) $level : null,
            'phone_battery_temp_c' => $temp !== null ? (float) $temp : null,
            'phone_charging' => $charging !== null ? !empty($charging) : null,
            'phone_battery_voltage_v' => $volt !== null ? (float) $volt : null,
            'phone_screen_on' => $screenOn !== null ? !empty($screenOn) : null,
            'last_report_at' => ($relayBms !== null && $relayBms['fresh'])
                ? ($relayBms['updated_at'] ?? $heartbeat->created_at?->toISOString())
                : $heartbeat->created_at?->toISOString(),
            'age_seconds' => ($relayBms !== null && $relayBms['fresh'])
                ? min($ageSeconds, (int) ($relayBms['age_seconds'] ?? $ageSeconds))
                : $ageSeconds,
            'ambient' => $ambient,
            'poll_ms' => $pollMs,
            'app_ver' => $appVersion,
            'version_code' => $versionCode,
            'version_code_source' => $versionCode === null ? 'unknown' : 'release_map',
        ]);
    }

    /**
     * Latest ambient climate reading (Xiaomi LYWSD03MMC) for a device, or null.
     *
     * @return array<string, mixed>|null
     */
    private function relayAmbient(string $sn): ?array
    {
        $row = \App\Models\EnvSample::query()
            ->where('device_sn', $sn)
            ->orderByDesc('captured_at')
            ->first();
        if ($row === null) {
            return null;
        }

        $ageSeconds = $row->captured_at
            ? max(0, (int) $row->captured_at->diffInSeconds(now()))
            : null;

        return [
            'temp_c'            => $row->temp_c !== null ? (float) $row->temp_c : null,
            'humidity_pct'      => $row->humidity_pct !== null ? (float) $row->humidity_pct : null,
            'sensor_battery_mv' => $row->sensor_battery_mv !== null ? (int) $row->sensor_battery_mv : null,
            'rssi'              => $row->rssi !== null ? (int) $row->rssi : null,
            'fresh'             => $ageSeconds !== null && $ageSeconds < 300,
            'age_seconds'       => $ageSeconds,
            'captured_at'       => $row->captured_at ? $row->captured_at->toISOString() : null,
        ];
    }

    /**
     * Latest LIVE BMS frame the relay posted for a device — a row that actually
     * carried a board frame (total_voltage_v is not null). Returns null if the
     * relay never posted a board frame, otherwise a freshness-tagged payload.
     *
     * The relay streams board frames ~every 2.1s while attached, so a frame
     * within RELAY_BOARD_FRESH_SEC means "real-time board telemetry available
     * right now" — used by the dashboard to prefer relay values over estimates.
     */
    private const RELAY_BOARD_FRESH_SEC = 60;

    private function relayLiveBms(string $sn): ?array
    {
        // 查询逻辑已抽到 RelayLiveBmsService（snapshot/overview/widget 共用）。
        return \App\Services\Dashboard\RelayLiveBmsService::current($sn);
    }

    /**
     * POST /api/auth/login — verify password or DASHBOARD_TOKEN, unlock session.
     */
    public function authLogin(Request $request): JsonResponse
    {
        $password = (string) $request->input('password', '');
        if ($password === '') {
            return ApiResponder::error(new ErrorObject('invalid_request', 'missing_password', '请输入密码'), 422);
        }

        // 1. Custom password (DashboardAuth) takes priority
        $ok = DashboardAuth::isConfigured() && DashboardAuth::verify($password);

        // 2. Fallback: legacy DASHBOARD_TOKEN from .env (constant-time compare)
        if (! $ok) {
            $expected = (string) env('DASHBOARD_TOKEN', '');
            $ok = $expected !== '' && hash_equals($expected, $password);
        }

        if (! $ok) {
            LoginBruteForceGuard::registerFailure($request->ip());
            return ApiResponder::error(new ErrorObject('unauthenticated', 'wrong_password', '密码错误'), 401);
        }

        LoginBruteForceGuard::clear($request->ip());
        $request->session()->regenerate();
        $request->session()->put('dashboard_unlocked', true);

        $refreshToken = DashboardRefreshToken::issue();

        return ApiResponder::success('auth', [
            'unlocked' => true,
            'refresh_token' => $refreshToken,
        ]);
    }

    public function authStatus(Request $request): JsonResponse
    {
        $unlocked = (bool) $request->session()->get('dashboard_unlocked', false);
        return ApiResponder::success('auth', [
            'unlocked' => $unlocked,
            'has_password' => DashboardAuth::isConfigured() || (string) env('DASHBOARD_TOKEN', '') !== '',
        ]);
    }

    public function authLogout(Request $request): JsonResponse
    {
        $token = (string) $request->input('refresh_token', '');
        if ($token !== '') {
            DashboardRefreshToken::revoke($token);
        }

        $request->session()->forget('dashboard_unlocked');
        $request->session()->invalidate();
        $request->session()->regenerateToken();
        return ApiResponder::success('auth', ['unlocked' => false]);
    }

    /**
     * POST /api/auth/change-password — change the stored dashboard password.
     * Requires an already-unlocked session.
     */
    public function authChangePassword(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'current_password' => ['required', 'string', 'min:1'],
            // min:8 — matches evtelemetry:set-dashboard-password. 4-char minimums
            // are online-bruteforceable even at 5 attempts/min.
            'new_password' => ['required', 'string', 'min:8'],
        ]);

        // Verify current password
        if (DashboardAuth::isConfigured()) {
            if (! DashboardAuth::verify($validated['current_password'])) {
                return ApiResponder::error(new ErrorObject('invalid_request', 'wrong_password', '当前密码错误'), 422);
            }
        } else {
            // No custom password set yet — verify against DASHBOARD_TOKEN as current
            $expected = (string) env('DASHBOARD_TOKEN', '');
            if ($expected === '' || ! hash_equals($expected, $validated['current_password'])) {
                return ApiResponder::error(new ErrorObject('invalid_request', 'wrong_password', '当前密码或令牌错误'), 422);
            }
        }

        DashboardAuth::set($validated['new_password']);

        return ApiResponder::success('auth', ['password_set' => true]);
    }

    /**
     * POST /api/auth/refresh — silent session re-establishment with a refresh token.
     *
     * Called by the app when the short-lived session has expired (a gated endpoint
     * answered 401 'unauthenticated'). The token rotates on every use, so a stolen
     * token has a limited window. Public + throttled (see routes/api.php).
     */
    public function authRefresh(Request $request): JsonResponse
    {
        $token = (string) $request->input('refresh_token', '');
        if (! DashboardRefreshToken::isValid($token)) {
            return ApiResponder::error(
                new ErrorObject('unauthenticated', 'invalid_refresh_token', '登录已失效，请重新登录'),
                401,
            );
        }

        $newToken = DashboardRefreshToken::rotate($token);

        $request->session()->regenerate();
        $request->session()->put('dashboard_unlocked', true);

        return ApiResponder::success('auth', [
            'unlocked' => true,
            'refresh_token' => $newToken,
        ]);
    }

    /**
     * GET /api/dashboard/settings?sn={serial}
     * Returns current calibration settings for the device (read-only display + editable fields).
     * Creates a row with defaults if none exists yet.
     */
    public function getSettings(Request $request): JsonResponse
    {
        $sn = (string) $request->query('sn', '');
        if ($sn === '') {
            $sn = (string) Device::query()->orderBy('id')->value('sn');
        }
        if ($sn === '') {
            return ApiResponder::error(new ErrorObject('not_found', 'no_device', '暂无设备'), 404);
        }

        $cal = BatteryCalibration::query()->where('device_sn', $sn)->firstOrNew(['device_sn' => $sn]);
        $trustedConsumption = $this->trustedConsumption->estimate($sn);

        // Read-only hardware (铭牌)
        $readonly = [
            'chemistry_type' => $cal->chemistry_type,
            'cell_series_count' => $cal->cell_series_count,
        ];

        // Editable priors
        $priors = [
            'bms_full_charge_voltage' => $cal->bms_full_charge_voltage,
            'bms_cutoff_voltage' => $cal->bms_cutoff_voltage,
            'max_charge_current_a' => $cal->max_charge_current_a,
            'charger_output_current_a' => $cal->charger_output_current_a,
            'ant_bms_displayed_power_w' => $cal->ant_bms_displayed_power_w,
            'ant_bms_measured_current_a' => $cal->ant_bms_measured_current_a,
            'nominal_voltage' => $cal->nominal_voltage,
            'nominal_capacity_ah' => $cal->nominal_capacity_ah,
            'capacity_tolerance_pct' => $cal->capacity_tolerance_pct ?? 20.0,
        ];

        // Editable algorithm thresholds
        $thresholds = [
            'temp_bucket_cold_max_c' => $cal->getTempBucketColdMaxC(),
            'temp_bucket_warm_max_c' => $cal->getTempBucketWarmMaxC(),
            'plateau_voltage_delta' => $cal->getPlateauVoltageDelta(),
            'plateau_min_minutes' => $cal->getPlateauMinMinutes(),
            'capacity_ema_alpha_base' => $cal->getCapacityEmaAlphaBase(),
        ];

        // Defaults metadata (so the UI knows what fallback to show)
        $defaults = [
            'temp_bucket_cold_max_c' => BatteryCalibration::DEFAULT_TEMP_BUCKET_COLD_MAX,
            'temp_bucket_warm_max_c' => BatteryCalibration::DEFAULT_TEMP_BUCKET_WARM_MAX,
            'plateau_voltage_delta' => BatteryCalibration::DEFAULT_PLATEAU_VOLTAGE_DELTA,
            'plateau_min_minutes' => BatteryCalibration::DEFAULT_PLATEAU_MIN_MINUTES,
            'capacity_ema_alpha_base' => BatteryCalibration::DEFAULT_CAPACITY_EMA_ALPHA_BASE,
            'capacity_tolerance_pct' => 20.0,
        ];

        return ApiResponder::success('settings', [
            'device_sn' => $sn,
            'readonly' => $readonly,
            'priors' => $priors,
            'thresholds' => $thresholds,
            'defaults' => $defaults,
            'priors_set_at' => $cal->priors_updated_at?->toISOString(),
            'wh_per_km_current' => $trustedConsumption['wh_per_km'],
            'total_calibration_samples' => $trustedConsumption['sample_count'],
            'cycle_count_baseline' => $cal->cycle_count_baseline,
            'cycle_count_baseline_wh' => $cal->cycle_count_baseline_wh,
            // Odometer baseline (configured dash reading) + the synced ride-km
            // snapshot taken when it was set. total = baseline + delta.
            'odometer_baseline_km' => $cal->odometer_baseline_km,
            'odometer_baseline_ride_km' => $cal->odometer_baseline_ride_km,
        ]);
    }

    /**
     * PUT /api/dashboard/settings
     * Body: { device_sn, priors: {...}, thresholds: {...} }
     * Only priors.* fields trigger priors_updated_at stamp; thresholds update silently.
     */
    public function updateSettings(Request $request): JsonResponse
    {
        $sn = (string) $request->input('device_sn', '');
        $priors = (array) $request->input('priors', []);
        $thresholds = (array) $request->input('thresholds', []);
        $cycleBaseline = $request->input('cycle_count_baseline');
        $odometerBaseline = $request->input('odometer_baseline_km');

        if ($sn === '') {
            return ApiResponder::error(new ErrorObject('invalid_request', 'missing_device_sn', '缺少 device_sn'), 422);
        }

        if (! Device::query()->where('sn', $sn)->exists()) {
            return ApiResponder::error(new ErrorObject('not_found', 'unknown_device', '车辆不存在'), 404);
        }

        $cal = BatteryCalibration::query()->firstOrNew(['device_sn' => $sn]);

        // Validation rules
        $rules = [
            // Priors (BMS specs)
            'bms_full_charge_voltage' => ['nullable', 'numeric', 'min:30', 'max:120'],
            'bms_cutoff_voltage' => ['nullable', 'numeric', 'min:20', 'max:80'],
            'max_charge_current_a' => ['nullable', 'numeric', 'min:0', 'max:200'],
            'charger_output_current_a' => ['nullable', 'numeric', 'min:0', 'max:200'],
            'ant_bms_displayed_power_w' => ['nullable', 'numeric', 'min:0', 'max:10000'],
            'ant_bms_measured_current_a' => ['nullable', 'numeric', 'min:0', 'max:200'],
            'nominal_voltage' => ['nullable', 'numeric', 'min:10', 'max:200'],
            'nominal_capacity_ah' => ['nullable', 'numeric', 'min:0', 'max:500'],
            'capacity_tolerance_pct' => ['nullable', 'numeric', 'min:1', 'max:100'],
            // Thresholds
            'temp_bucket_cold_max_c' => ['nullable', 'numeric', 'min:-50', 'max:50'],
            'temp_bucket_warm_max_c' => ['nullable', 'numeric', 'min:0', 'max:80'],
            'plateau_voltage_delta' => ['nullable', 'numeric', 'min:0.01', 'max:5'],
            'plateau_min_minutes' => ['nullable', 'integer', 'min:1', 'max:180'],
            'capacity_ema_alpha_base' => ['nullable', 'numeric', 'min:0.001', 'max:0.5'],
        ];

        $errors = [];
        $priorsTouched = false;
        $thresholdsTouched = false;

        foreach ($priors as $key => $value) {
            if (! array_key_exists($key, $rules)) continue;
            $validator = validator(['v' => $value], ['v' => $rules[$key]]);
            if ($validator->fails()) {
                $errors[$key] = $validator->errors()->first('v');
            } else {
                $cal->{$key} = $value;
                $priorsTouched = true;
            }
        }
        foreach ($thresholds as $key => $value) {
            if (! array_key_exists($key, $rules)) continue;
            $validator = validator(['v' => $value], ['v' => $rules[$key]]);
            if ($validator->fails()) {
                $errors[$key] = $validator->errors()->first('v');
            } else {
                $cal->{$key} = $value;
                $thresholdsTouched = true;
            }
        }

        // A-29: cross-field consistency. Each field passes its own numeric
        // range, but a self-contradictory pair (e.g. cutoff=70 / full=40) makes
        // SocCurveFitter reject every sample — the curve never fits and
        // is_calibrated stays false with no error surfaced. Read the merged
        // effective value (submitted OR existing) off the model.
        $full = $cal->bms_full_charge_voltage;
        $cutoff = $cal->bms_cutoff_voltage;
        if ($full !== null && $cutoff !== null && ! ($cutoff < $full)) {
            $errors['bms_cutoff_voltage'] = 'cutoff 电压必须低于满充电压';
        }
        $cold = $cal->temp_bucket_cold_max_c;
        $warm = $cal->temp_bucket_warm_max_c;
        if ($cold !== null && $warm !== null && ! ($cold < $warm)) {
            $errors['temp_bucket_cold_max_c'] = 'cold 温度上限必须低于 warm 上限';
        }

        if (! empty($errors)) {
            return ApiResponder::error(
                new ErrorObject('invalid_request', 'validation_failed', '参数校验失败'),
                422,
                ['errors' => $errors]
            );
        }

        if ($priorsTouched) {
            $cal->priors_updated_at = Carbon::now();
        }

        // Handle cycle_count_baseline: when set, also record the baseline discharge Wh
        if ($cycleBaseline !== null) {
            $baselineInt = (int) $cycleBaseline;
            if ($baselineInt < 0) {
                return ApiResponder::error(new ErrorObject('invalid_request', 'invalid_cycle_baseline', '循环次数不能为负'), 422);
            }
            $cal->cycle_count_baseline = $baselineInt;
            // Only update baseline Wh if not already set, or explicitly re-setting.
            // Source = upstream monthly aggregates (complete), not the 20-row
            // capped device_ride_history window.
            $device = Device::query()->where('sn', $sn)->first();
            $cal->cycle_count_baseline_wh = $device !== null
                ? round((float) \App\Models\BmsEnergyInterval::query()
                    ->where('device_sn', $device->sn)
                    ->sum('energy_wh'), 3)
                : 0.0;
        }

        // Handle odometer_baseline_km: the configured dash ODO reading. Every
        // (re-)set re-snapshots the upstream cumulative km so the displayed
        // total = baseline + (mileage accrued after this moment).
        if ($odometerBaseline !== null) {
            if (! is_numeric($odometerBaseline) || (float) $odometerBaseline < 0 || (float) $odometerBaseline > 200000) {
                return ApiResponder::error(new ErrorObject('invalid_request', 'invalid_odometer_baseline', '总里程需在 0–200000 km 之间'), 422);
            }
            $device = Device::query()->where('sn', $sn)->first();
            $cal->odometer_baseline_km = round((float) $odometerBaseline, 1);
            $cal->odometer_baseline_ride_km = $device !== null
                ? round((float) \App\Models\DeviceRideMonthSummary::query()
                    ->where('device_id', $device->id)
                    ->sum('total_mileage_km'), 1)
                : 0.0;
        }

        $cal->save();

        return ApiResponder::success('settings', [
            'device_sn' => $sn,
            'priors_updated' => $priorsTouched,
            'thresholds_updated' => $thresholdsTouched,
            'priors' => [
                'bms_full_charge_voltage' => $cal->bms_full_charge_voltage,
                'bms_cutoff_voltage' => $cal->bms_cutoff_voltage,
                'max_charge_current_a' => $cal->max_charge_current_a,
                'charger_output_current_a' => $cal->charger_output_current_a,
                'ant_bms_displayed_power_w' => $cal->ant_bms_displayed_power_w,
                'ant_bms_measured_current_a' => $cal->ant_bms_measured_current_a,
                'nominal_voltage' => $cal->nominal_voltage,
                'nominal_capacity_ah' => $cal->nominal_capacity_ah,
                'capacity_tolerance_pct' => $cal->capacity_tolerance_pct,
            ],
            'thresholds' => [
                'temp_bucket_cold_max_c' => $cal->getTempBucketColdMaxC(),
                'temp_bucket_warm_max_c' => $cal->getTempBucketWarmMaxC(),
                'plateau_voltage_delta' => $cal->getPlateauVoltageDelta(),
                'plateau_min_minutes' => $cal->getPlateauMinMinutes(),
                'capacity_ema_alpha_base' => $cal->getCapacityEmaAlphaBase(),
            ],
            'cycle_count_baseline' => $cal->cycle_count_baseline,
            'cycle_count_baseline_wh' => $cal->cycle_count_baseline_wh,
            'odometer_baseline_km' => $cal->odometer_baseline_km,
            'odometer_baseline_ride_km' => $cal->odometer_baseline_ride_km,
        ]);
    }

    /**
     * POST /api/dashboard/vehicles/{sn}/image
     * Upload a vehicle photo (max 5 MB, jpg/png/gif/webp).
     */
    public function uploadVehicleImage(Request $request, string $sn): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();
        if ($device === null) {
            return $this->notFound();
        }

        $request->validate([
            'image' => ['required', 'image', 'mimes:jpeg,png,jpg,gif,webp', 'max:5120'],
        ]);

        $file = $request->file('image');
        // Use the MIME-guessed extension, NOT the client-supplied one:
        // getClientOriginalExtension() would let a .php file with image content
        // pass validation and land executable in public/uploads (RCE).
        $ext = $file->extension();
        $filename = 'vehicle_'.$sn.'_'.time().'.'.$ext;
        $file->move(public_path('uploads'), $filename);

        $device->vehicle_image = 'uploads/'.$filename;
        $device->save();

        return ApiResponder::success('image', [
            'url' => asset($device->vehicle_image),
            'path' => $device->vehicle_image,
        ]);
    }

    /**
     * GET /api/dashboard/vehicles/{sn}/image
     * Returns the custom vehicle image URL (or 404 if not set).
     */
    public function getVehicleImage(string $sn): JsonResponse
    {
        $device = Device::query()->where('sn', $sn)->first();
        if ($device === null) {
            return $this->notFound();
        }
        if (! $device->vehicle_image) {
            return ApiResponder::error(new ErrorObject('not_found', 'no_image', '暂无车辆图片'), 404);
        }

        return ApiResponder::success('image', [
            'url' => asset($device->vehicle_image),
        ]);
    }

    /**
     * Filter out implausible top-speed values for short rides.
     *
     * GPS noise on short trips can produce false speed ceilings that
     * pass the multi-peak detection (because noise happens to cluster).
     * This heuristic suppresses values that are physically unlikely
     * for the given ride distance.
     */
    private static function filterImplausibleSpeed(?float $speed, float $mileage): ?float
    {
        if ($speed === null) return null;

        // Short rides: GPS noise is a larger fraction of samples.
        if ($mileage < 2.0 && $speed > 50.0) return null;
        if ($mileage < 5.0 && $speed > 85.0) return null;

        return $speed;
    }

    private function upstreamError(array $result, string $code, int $status = 422): JsonResponse
    {
        $error = is_array($result['error'] ?? null) ? $result['error'] : [];

        return ApiResponder::error(new ErrorObject(
            'upstream_error',
            (string) ($error['code'] ?? $code),
            (string) ($error['message'] ?? 'ninecli 请求失败。'),
        ), $status);
    }

    private function notFound(): JsonResponse
    {
        return ApiResponder::error(new ErrorObject('invalid_request_error', 'device_not_found', '未找到车辆。'), 404);
    }

    /**
     * POST /api/bms-debug-log
     * Append raw BLE hex data + timestamp to a log file for remote debugging.
     * Body: { "ts": "ISO timestamp", "hex": "aa bb cc ..." }
     */
    public function bmsDebugLog(Request $request): JsonResponse
    {
        // Strip CR/LF from both fields so a crafted payload can't forge extra log lines.
        $ts = str_replace(["\r", "\n"], '', (string) $request->input('ts', now()->toISOString()));
        // Cap hex length to bound single-line size and log growth.
        $hex = mb_substr(str_replace(["\r", "\n"], '', (string) $request->input('hex', '')), 0, 4000);
        $line = "[{$ts}] {$hex}\n";

        $path = storage_path('logs/bms-debug.log');
        // Size-based rotation: past 10MB the old file() + rewrite did a full
        // 10MB read+write on EVERY subsequent log line. A rename is O(1);
        // one generation of history is kept in bms-debug.1.log.
        if (file_exists($path) && filesize($path) > 10_000_000) {
            @rename($path, storage_path('logs/bms-debug.1.log'));
        }
        file_put_contents($path, $line, FILE_APPEND | LOCK_EX);

        return ApiResponder::success('logged', ['bytes' => strlen($line)]);
    }

    /**
     * GET /api/bms-debug-log
     * Return the raw BMS debug log for viewing in the browser.
     */
    public function bmsDebugView(Request $request): JsonResponse
    {
        $request->validate([
            'offset' => ['nullable', 'integer', 'min:0'],
            'limit'  => ['nullable', 'integer', 'min:1', 'max:1000'],
        ]);

        $path = storage_path('logs/bms-debug.log');
        $lines = [];
        if (file_exists($path)) {
            $content = file_get_contents($path);
            $lines = array_filter(explode("\n", $content), fn($l) => trim($l) !== '');
            $total = count($lines);
            $offset = (int) $request->query('offset', 0);
            $limit = (int) $request->query('limit', 200);
            $lines = array_slice($lines, $offset, $limit);
        } else {
            $total = 0;
        }

        return ApiResponder::success('log', [
            'total' => $total,
            'offset' => (int) $request->query('offset', 0),
            'limit' => (int) $request->query('limit', 200),
            'lines' => array_values($lines),
        ]);
    }
}
