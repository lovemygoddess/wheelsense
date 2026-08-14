<?php

namespace App\Services\Calibration;

use App\Models\Device;
use App\Models\DeviceSnapshot;
use App\Services\NinebotApiService;
use Carbon\Carbon;

/**
 * Snapshot collector used by the polling command.
 *
 * - Calls ninecli status + battery
 * - Saves the snapshot, deduplicated per (device_id, minute_bucket) by UUID-key upsert
 * - Returns the saved snapshot or null on upstream failure
 */
class SnapshotCollectorService
{
    public function __construct(private readonly NinebotApiService $ninebotApi) {}

    public function collect(Device $device): ?DeviceSnapshot
    {
        $statusResult = $this->ninebotApi->status($device->sn);
        if (($statusResult['ok'] ?? false) !== true) {
            return null;
        }
        $status = is_array($statusResult['data'] ?? null) ? $statusResult['data'] : [];
        $state = is_array($status['state'] ?? null) ? $status['state'] : $status;
        $raw = is_array($state['raw'] ?? null) ? $state['raw'] : $status;
        $loc = is_array($state['loc'] ?? null) ? $state['loc'] : (is_array($raw['loc'] ?? null) ? $raw['loc'] : []);

        $batteryResult = $this->ninebotApi->battery($device->sn);
        $battery = ($batteryResult['ok'] ?? false) === true && is_array($batteryResult['data'] ?? null)
            ? $batteryResult['data']
            : [];
        $batteryData = is_array($battery['data'] ?? null) ? $battery['data'] : $battery;
        $batteryList = is_array($batteryData['battery_list'] ?? null) ? $batteryData['battery_list'] : [];
        $bms = is_array($batteryList[0] ?? null) ? $batteryList[0] : [];

        $now = Carbon::now();
        $bucket = CalibrationConstants::minuteBucket($now);

        $snapshotData = [
            'device_id' => $device->id,
            'minute_bucket' => $bucket,
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

        // Upsert by (device_id, minute_bucket) to dedup. The select-then-insert
        // races the web-path writer (VehiclePayloadMapper::collectSnapshot) on
        // the first write of a minute — the UNIQUE(device_id, minute_bucket)
        // index makes the loser throw; catch that and degrade to an update.
        $snap = DeviceSnapshot::query()
            ->where('device_id', $device->id)
            ->where('minute_bucket', $bucket)
            ->first();

        if ($snap === null) {
            try {
                $snap = DeviceSnapshot::create($snapshotData + ['created_at' => $now, 'updated_at' => $now]);
            } catch (\Illuminate\Database\QueryException $e) {
                if (! str_contains($e->getMessage(), 'UNIQUE')) {
                    throw $e;
                }
                $snap = DeviceSnapshot::query()
                    ->where('device_id', $device->id)
                    ->where('minute_bucket', $bucket)
                    ->first();
                if ($snap === null) {
                    throw $e; // truly inconsistent — surface it
                }
                $snap->fill($snapshotData);
                $snap->updated_at = $now;
                $snap->save();
            }
        } else {
            $snap->fill($snapshotData);
            $snap->updated_at = $now;
            $snap->save();
        }
        return $snap;
    }

    private function intValue(mixed $value): ?int
    {
        if ($value === null || $value === '') return null;
        if (is_bool($value)) return $value ? 1 : 0;
        if (is_numeric($value)) return (int) $value;
        return in_array(strtolower((string) $value), ['on', 'true', 'charging', 'locked'], true) ? 1 : 0;
    }
}
