<?php

namespace App\Console\Commands;

use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Services\Calibration\SnapshotCollectorService;
use App\Services\Dashboard\RideHistorySyncService;
use App\Services\Rides\RideEnergyAttributionService;
use App\Services\NinebotApiService;
use Carbon\Carbon;
use Illuminate\Console\Command;

class PollDevicesCommand extends Command
{
    protected $signature = 'evtelemetry:poll-devices';
    protected $description = 'Poll NineCLI, sync rides, persist snapshots and attribute measured ride energy';

    public function __construct(
        private readonly SnapshotCollectorService $collector,
        private readonly NinebotApiService $ninebotApi,
        private readonly RideHistorySyncService $rideSync,
        private readonly RideEnergyAttributionService $rideEnergy,
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $result = $this->ninebotApi->vehicles();
        if (($result['ok'] ?? false) !== true) {
            $this->warn('ninecli vehicles failed: ' . json_encode($result['error'] ?? null));
            return self::SUCCESS;
        }

        $vehicles = is_array($result['data'] ?? null) ? $result['data'] : [];
        $count = 0;

        foreach ($vehicles as $vehicle) {
            $sn = $vehicle['wnumber'] ?? $vehicle['sn'] ?? null;
            if (! is_string($sn) || $sn === '') continue;

            // Per-device isolation: one failing device (upstream hiccup, DB
            // race, detector exception) must NOT skip the remaining devices
            // in this poll round.
            try {
                $device = Device::query()->updateOrCreate(
                    ['sn' => $sn],
                    [
                        'device_name' => $vehicle['device_name'] ?? $vehicle['ble_name'] ?? $sn,
                        'model' => $vehicle['vehicle_name_en'] ?? $vehicle['vehicle_name'] ?? $sn,
                        'img' => $vehicle['img_url'] ?? $vehicle['v6_light_img_url'] ?? null,
                        'raw' => $vehicle,
                    ]
                );

                // Sync current-month rides via RideHistorySyncService（统一字段解析，
                // 避免 PollDevicesCommand 的 started_at/ended_at 无 fallback 导致 null
                // 覆盖 RideHistorySyncService 已存的正确值）。
                $month = Carbon::now()->format('Ym');
                $travel = $this->ninebotApi->travel($sn, $month);
                if (($travel['ok'] ?? false) === true) {
                    $data = is_array($travel['data'] ?? null) ? $travel['data'] : [];
                    $list = is_array($data['list'] ?? null) ? $data['list'] : [];
                    $this->rideSync->syncMonth($device, $month, $list);
                    $this->rideEnergy->attributeMonth($device, $month);
                    // Authoritative monthly aggregates (odometer/cycle-count source).
                    $this->rideSync->syncMonthSummary($device, $month, $data);
                }

                // Self-heal history: one missing past month per poll run (oldest
                // first). Months that are empty upstream get an all-zero row so
                // they are never refetched.
                $missing = $this->rideSync->missingSummaryMonths($device);
                if ($missing !== []) {
                    $backfillMonth = $missing[0];
                    $bt = $this->ninebotApi->travel($sn, $backfillMonth);
                    if (($bt['ok'] ?? false) === true) {
                        $bData = is_array($bt['data'] ?? null) ? $bt['data'] : [];
                        $this->rideSync->syncMonth($device, $backfillMonth, is_array($bData['list'] ?? null) ? $bData['list'] : []);
                        $this->rideEnergy->attributeMonth($device, $backfillMonth);
                        $this->rideSync->syncMonthSummary($device, $backfillMonth, $bData);
                        $this->info("  backfilled month summary {$backfillMonth} for {$sn}");
                    }
                }

                // Collect a new snapshot for this device.
                $snap = $this->collector->collect($device);
                if ($snap === null) continue;

                $count++;
            } catch (\Throwable $e) {
                $this->warn("  {$sn}: poll failed: " . $e->getMessage());
                \Illuminate\Support\Facades\Log::warning("PollDevicesCommand: {$sn} failed: " . $e->getMessage());
                continue;
            }
        }

        // Cache the newest EZVIZ alarm for the widget/notification path.
        // The widget summary endpoint must stay cheap (no live upstream
        // calls), so the poller refreshes this cache every 5 minutes instead.
        $this->pollEzvizLatestAlarm();

        $this->info("Poll done. devices={$count}");
        return self::SUCCESS;
    }

    private const EZVIZ_ALARM_CACHE_KEY = 'ezviz:latest_alarm';

    private function pollEzvizLatestAlarm(): void
    {
        try {
            $ezviz = app(\App\Services\EzvizApiService::class);
            if (! $ezviz->isConfigured()) return;

            $devices = $ezviz->listDevices();
            $serial = $devices[0]['deviceSerial'] ?? null;
            if (! is_string($serial) || $serial === '') return;

            $alarms = $ezviz->alarmList($serial, 1);
            $latest = $alarms[0] ?? null;
            if (! is_array($latest)) {
                \Illuminate\Support\Facades\Cache::forget(self::EZVIZ_ALARM_CACHE_KEY);
                return;
            }
            \Illuminate\Support\Facades\Cache::put(self::EZVIZ_ALARM_CACHE_KEY, [
                'id' => $latest['alarmId'] ?? null,
                'title' => $latest['alarmName'] ?? null,
                'time_ms' => $latest['alarmTime'] ?? null,
                'pic_url' => $latest['alarmPicUrl'] ?? null,
            ], now()->addDay());
        } catch (\Throwable $e) {
            // The camera poll must never break vehicle polling.
            \Illuminate\Support\Facades\Log::debug('PollDevicesCommand: ezviz alarm poll failed: ' . $e->getMessage());
        }
    }
}
