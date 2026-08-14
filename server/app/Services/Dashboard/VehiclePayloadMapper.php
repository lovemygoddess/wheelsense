<?php

namespace App\Services\Dashboard;

use App\Models\BatteryCalibration;
use App\Models\BmsEnergyInterval;
use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Models\DeviceRideMonthSummary;
use App\Models\DeviceSnapshot;
use App\Services\NinebotApiService;
use App\Support\CoordTransform;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Http;

/**
 * Owns the Vehicle / DeviceSnapshot payload shaping and the
 * "fetch fresh status+battery then persist a snapshot" pipeline.
 *
 * Pure mapping concerns — no HTTP concerns. Controllers inject this
 * service and call it; response wrapping stays in the controller via
 * ApiResponder.
 */
class VehiclePayloadMapper
{
    public function __construct(private readonly NinebotApiService $ninebotApi) {}

    /**
     * Reshape the upstream ninecli `GET /vehicles` response (or pre-shaped
     * `{ vehicles: [...] }` wrapper) into an internal-friendly array used
     * by the `vehicles()` endpoint for upsert.
     *
     * @return list<array{sn:string,name:string,model:string,image_url:?string,raw:array<string,mixed>}>
     */
    public function listFromUpstream(mixed $data): array
    {
        if (is_array($data) && isset($data['vehicles']) && is_array($data['vehicles'])) {
            $data = $data['vehicles'];
        }
        if (! is_array($data)) {
            return [];
        }

        $vehicles = [];
        foreach ($data as $vehicle) {
            if (! is_array($vehicle)) {
                continue;
            }
            $sn = $vehicle['sn'] ?? $vehicle['wnumber'] ?? null;
            if (! is_string($sn) || $sn === '') {
                continue;
            }
            $vehicles[] = [
                'sn' => $sn,
                'name' => $vehicle['name'] ?? $vehicle['device_name'] ?? $vehicle['ble_name'] ?? $sn,
                'model' => $vehicle['model'] ?? $vehicle['vehicle_name_en'] ?? $vehicle['vehicle_name'] ?? $sn,
                'image_url' => $vehicle['image_url'] ?? $vehicle['v6_light_img_url'] ?? $vehicle['img_url'] ?? null,
                'raw' => $vehicle,
            ];
        }

        return $vehicles;
    }

    /**
     * Compose the JSON payload for one vehicle row in the dashboard list.
     *
     * @return array<string, mixed>
     */
    public function mapDevice(Device $device, ?DeviceSnapshot $snapshot): array
    {
        $raw = is_array($device->raw) ? $device->raw : [];

        $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
        $effectiveCycles = $this->computeEffectiveCycleCount($device, $cal);

        return [
            'sn' => $device->sn,
            'name' => $device->device_name,
            'model' => $device->model,
            'color' => $raw['color'] ?? null,
            'vehicle_name_zh' => $raw['vehicle_name_zh'] ?? null,
            'image_url' => $device->img,
            'custom_image_url' => $device->vehicle_image ? asset($device->vehicle_image) : null,
            'latest' => $snapshot ? $this->mapSnapshot($snapshot) : null,
            'effective_cycle_count' => $effectiveCycles,
            // Total odometer: user-supplied baseline + locally-synced ride
            // mileage delta. null until the user enters their dash reading
            // in settings (upstream /vehicles total_mileage is always null).
            'total_mileage_km' => $this->computeTotalMileageKm($device, $cal),
        ];
    }

    /**
     * Compose the JSON payload for one DeviceSnapshot row.
     *
     * @return array<string, mixed>
     */
    public function mapSnapshot(DeviceSnapshot $snapshot): array
    {
        $desc = $snapshot->location_desc;
        if ($desc === null && $snapshot->latitude !== null && $snapshot->longitude !== null) {
            $desc = $this->reverseGeocode($snapshot->latitude, $snapshot->longitude);
            if ($desc !== null) {
                $snapshot->updateQuietly(['location_desc' => $desc]);
            }
        }

        // Extract vendor estimates from the raw ninebot API response.
        // snapshot.raw = ['status' => [...], 'battery' => [...]]
        // ninecli 0.1.7 returns the state fields FLAT under raw.status (no
        // nested "state" key) — the old code only looked at
        // raw.status.state, so ai/precise were always null (dashboard "AI
        // 预估" showed '—' forever). Support both shapes.
        $raw = $snapshot->raw ?: [];
        $state = is_array($raw['status']['state'] ?? null)
            ? $raw['status']['state']
            : (is_array($raw['status'] ?? null) ? $raw['status'] : []);
        $vendorAi = $state['ai_estimate_mileage'] ?? null;
        $vendorPrecise = $state['precise_estimate_mileage'] ?? null;

        return [
            'timestamp' => $snapshot->created_at->toISOString(),
            'battery' => $snapshot->dump_energy,
            'endurance' => $snapshot->estimate_mileage,
            'ai_estimate_mileage' => $vendorAi !== null ? (float) $vendorAi : null,
            'precise_estimate_mileage' => $vendorPrecise !== null ? (float) $vendorPrecise : null,
            'charging' => $snapshot->charging_state === 1,
            'power' => $snapshot->power_status,
            'lock' => $snapshot->lock_status,
            'gsm' => $snapshot->gsm,
            'gsm_time' => $snapshot->gsm_time,
            'bms_voltage' => $snapshot->bms_voltage,
            'batt_temp' => $snapshot->batt_temp,
            'bms_cycles' => $snapshot->bms_cycles,
            'bms_score' => $snapshot->bms_score,
            'charging_power' => $snapshot->charging_power,
            'remain_charge_time' => $snapshot->remain_charge_time,
            'location' => ($snapshot->latitude !== null && $snapshot->longitude !== null) ? [
                'latitude' => $snapshot->latitude,
                'longitude' => $snapshot->longitude,
                'description' => $desc,
            ] : null,
        ];
    }

    /**
     * Fetch a fresh status+battery snapshot from upstream, normalize it,
     * and persist a new DeviceSnapshot row. Falls back to the most-recent
     * stored snapshot on upstream errors so the dashboard still has *some*
     * data to show.
     */
    public function collectSnapshot(Device $device): ?DeviceSnapshot
    {
        $statusResult = $this->ninebotApi->status($device->sn);

        if (($statusResult['ok'] ?? false) !== true) {
            return $device->snapshots()->latest()->first();
        }

        $status = is_array($statusResult['data'] ?? null) ? $statusResult['data'] : [];
        $state = is_array($status['state'] ?? null) ? $status['state'] : $status;
        $raw = is_array($state['raw'] ?? null) ? $state['raw'] : $status;
        $batteryResult = $this->ninebotApi->battery($device->sn);
        $battery = ($batteryResult['ok'] ?? false) === true && is_array($batteryResult['data'] ?? null)
            ? $batteryResult['data']
            : [];
        $batteryData = is_array($battery['data'] ?? null) ? $battery['data'] : $battery;
        $batteryList = is_array($batteryData['battery_list'] ?? null) ? $batteryData['battery_list'] : [];
        $bms = is_array($batteryList[0] ?? null) ? $batteryList[0] : [];
        $loc = is_array($state['loc'] ?? null) ? $state['loc'] : (is_array($raw['loc'] ?? null) ? $raw['loc'] : []);

        $now = Carbon::now();
        $bucket = $now->format('Y-m-d H:i:00');

        $snapshotData = [
            'gsm' => $state['gsm'] ?? $raw['gsm'] ?? null,
            'gsm_time' => $state['gsm_time'] ?? $raw['gsm_time'] ?? null,
            'pwr' => $this->intValue($state['power'] ?? $state['pwr'] ?? $raw['pwr'] ?? null),
            'dump_energy' => $this->intValue($state['battery'] ?? $state['dump_energy'] ?? $raw['dump_energy'] ?? null),
            'bms_voltage' => $bms['bms_volt'] ?? $batteryData['bms_voltage'] ?? null,
            'batt_temp' => $bms['bat_temp'] ?? $batteryData['batt_temp'] ?? null,
            'bms_cycles' => $bms['bms_cycle'] ?? $batteryData['bms_cycles'] ?? null,
            'bms_score' => $bms['score'] ?? $batteryData['bms_score'] ?? null,
            'charging_power' => $batteryData['charging_power'] ?? null,
            'estimate_mileage' => $state['endurance'] ?? $state['precise_estimate_mileage'] ?? $raw['precise_estimate_mileage'] ?? null,
            'latitude' => $loc['lat'] ?? $loc['latitude'] ?? null,
            'longitude' => $loc['lon'] ?? $loc['longitude'] ?? null,
            'location_desc' => $loc['description'] ?? null,
            'charging_state' => $this->intValue($state['charging'] ?? $raw['charging'] ?? null),
            'power_status' => $this->intValue($state['power'] ?? $raw['pwr'] ?? null),
            'lock_status' => $this->intValue($state['lock'] ?? $state['lock_status'] ?? $loc['lock'] ?? null),
            'remain_charge_time' => $state['remain_charge_time'] ?? $raw['remain_charge_time'] ?? null,
            'raw' => ['status' => $status, 'battery' => $battery],
        ];

        // Upsert by (device_id, minute_bucket) — 与 SnapshotCollectorService 一致。
        // web 端高频打开时同分钟内复用同一行，避免表膨胀（曾因缺失 minute_bucket
        // 导致 4031 条空桶 snapshot）+ 重复触发充电检测。
        // select-then-insert 与调度器写入在每分钟首写时存在竞态——UNIQUE 索引会
        // 让晚到的一方抛 QueryException，这里捕获后降级为 update。
        $snap = DeviceSnapshot::query()
            ->where('device_id', $device->id)
            ->where('minute_bucket', $bucket)
            ->first();

        if ($snap === null) {
            try {
                $snap = $device->snapshots()->create($snapshotData + [
                    'minute_bucket' => $bucket,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            } catch (\Illuminate\Database\QueryException $e) {
                if (! str_contains($e->getMessage(), 'UNIQUE')) {
                    throw $e;
                }
                $snap = DeviceSnapshot::query()
                    ->where('device_id', $device->id)
                    ->where('minute_bucket', $bucket)
                    ->first();
                if ($snap === null) {
                    throw $e;
                }
                $snap->fill($snapshotData);
                $snap->minute_bucket = $bucket;
                $snap->updated_at = $now;
                $snap->save();
            }
        } else {
            $snap->fill($snapshotData);
            $snap->minute_bucket = $bucket;
            $snap->updated_at = $now;
            $snap->save();
        }

        return $snap;
    }

    /**
     * Compute effective cycle count for a device. Public so the battery
     * overview endpoint can reuse it without going through mapDevice().
     *
     * Energy source is device_ride_month_summary (authoritative upstream
     * monthly aggregates) — SUM(device_ride_history.energy) only covers the
     * latest 20 rides per month and silently undercounts by ~80%.
     */
    public function computeEffectiveCycleCount(Device $device, ?BatteryCalibration $cal): ?float
    {
        if (!$cal || $cal->cycle_count_baseline === null || $cal->cycle_count_baseline_wh === null) {
            return null;
        }
        $capWh = $cal->capacity_wh_estimate;
        if (($capWh === null || $capWh <= 0) && $cal->nominal_voltage !== null && $cal->nominal_capacity_ah !== null) {
            $capWh = (float) $cal->nominal_voltage * (float) $cal->nominal_capacity_ah;
        }
        if ($capWh === null || $capWh <= 0) {
            return null;
        }
        $totalWh = (float) BmsEnergyInterval::query()
            ->where('device_sn', $device->sn)
            ->sum('energy_wh');
        $deltaWh = $totalWh - $cal->cycle_count_baseline_wh;
        return round($cal->cycle_count_baseline + ($deltaWh / $capWh), 1);
    }

    /**
     * Total odometer in km = user-entered dash baseline + ride mileage
     * accrued since the baseline was captured. Same pattern as
     * computeEffectiveCycleCount(): baseline_km is the ground-truth ODO
     * reading, baseline_ride_km is the upstream cumulative km at capture.
     *
     * Uses device_ride_month_summary (authoritative monthly aggregates).
     * The old SUM(device_ride_history.mileage) only covered the latest
     * 20 rides per month AND fluctuated as positional rows overwrote each
     * other — the displayed total was frozen at the baseline forever.
     */
    public function computeTotalMileageKm(Device $device, ?BatteryCalibration $cal): ?float
    {
        if (!$cal || $cal->odometer_baseline_km === null || $cal->odometer_baseline_ride_km === null) {
            return null;
        }
        $totalRideKm = (float) DeviceRideMonthSummary::query()
            ->where('device_id', $device->id)
            ->sum('total_mileage_km');
        $delta = $totalRideKm - (float) $cal->odometer_baseline_ride_km;
        // Guard against negative drift (summary rows pruned/re-synced): the
        // displayed odometer should never go below the entered baseline.
        return round((float) $cal->odometer_baseline_km + max(0.0, $delta), 1);
    }

    private function intValue(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        if (is_numeric($value)) {
            return (int) $value;
        }

        return in_array(strtolower((string) $value), ['on', 'true', 'charging', 'locked'], true) ? 1 : 0;
    }

    /**
     * Call AMap reverse geocoding API to convert lat/lng to a Chinese address.
     * Returns null on failure or if AMAP_KEY is not configured.
     * Result is truncated to 200 characters.
     */
    private function reverseGeocode(float $lat, float $lng): ?string
    {
        $key = (string) env('AMAP_KEY', '');
        if ($key === '') {
            return null;
        }

        // AMap's REST Regeo API expects GCJ-02 (火星坐标系). The ninebot
        // GPS hardware reports WGS-84 — these are offset by 50-700m inside
        // China. The frontend's MapView already does this conversion for
        // the marker; this is the symmetric fix for the cached address
        // label so the two stay aligned.
        //
        // History: before this fix, the cached location_desc was off by
        // the same offset as the map marker — but the marker looked
        // right because MapView.wgs84togcj02 happened client-side. The
        // server-side cache missed the conversion and stored an address
        // that pointed to a different street/POI than where the scooter
        // actually was. To refresh pre-fix cached rows, run:
        //   php artisan evtelemetry:clear-location-desc
        [$gcjLat, $gcjLng] = CoordTransform::wgs84ToGcj02($lat, $lng);

        $url = sprintf(
            'https://restapi.amap.com/v3/geocode/regeo?key=%s&location=%s,%s&output=json',
            urlencode($key),
            $gcjLng,
            $gcjLat,
        );

        try {
            // @file_get_contents has a 60s default timeout — a slow/dead Amap API
            // would block the whole request pipeline (vehicles/snapshot/overview).
            $response = Http::timeout(4)->get($url);
            if (! $response->ok()) {
                return null;
            }
            $data = $response->json();
            if (($data['status'] ?? '') === '1' && ! empty($data['regeocode']['formatted_address'])) {
                return mb_substr((string) $data['regeocode']['formatted_address'], 0, 200);
            }
        } catch (\Throwable) {
            // Silently ignore — upstream remains null
        }

        return null;
    }
}
