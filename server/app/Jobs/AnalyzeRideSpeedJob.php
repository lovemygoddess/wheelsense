<?php

namespace App\Jobs;

use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Services\NinebotApiService;
use App\Services\SpeedAnalyzer;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Log;

class AnalyzeRideSpeedJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue;

    public int $rideId;
    // NinebotApiService worst-case ~26s (8s timeout × 3 attempts + backoff).
    // timeout must exceed that so the worker is not hard-killed mid-flight
    // (leaving status=processing forever).
    public int $timeout = 120;
    public int $tries = 1;

    public function __construct(int $rideId)
    {
        $this->rideId = $rideId;
    }

    public function handle(NinebotApiService $api): void
    {
        $ride = DeviceRideHistory::find($this->rideId);
        if ($ride === null) {
            Log::warning("AnalyzeRideSpeedJob: ride not found (id={$this->rideId})");
            return;
        }

        // Already terminal — skip (duplicate dispatch / redelivery).
        if (in_array($ride->speed_analysis_status, ['done', 'skipped'], true)) {
            return;
        }

        $this->markProcessing($ride);

        try {
            // Synthetic / bootstrap rides never have upstream trails.
            if ($this->isSyntheticRideId((string) $ride->ride_id)) {
                $this->markTerminal($ride, 'skipped');
                Log::info("AnalyzeRideSpeedJob: ride={$ride->ride_id} skipped (synthetic)");
                return;
            }

            $deviceSn = Device::where('id', $ride->device_id)->value('sn');
            if ($deviceSn === null) {
                $this->markTerminal($ride, 'skipped');
                Log::info("AnalyzeRideSpeedJob: ride={$ride->ride_id} skipped (no device)");
                return;
            }

            $upstreamId = is_array($ride->payload) ? ($ride->payload['travel_id'] ?? null) : null;
            if ($upstreamId === null || $upstreamId === '') {
                $this->markTerminal($ride, 'skipped');
                Log::info("AnalyzeRideSpeedJob: ride={$ride->ride_id} skipped (no travel_id)");
                return;
            }

            $resp = $api->travelDetail($deviceSn, (string) $upstreamId);
            if (($resp['ok'] ?? false) !== true) {
                // Transient upstream error — mark failed so the 1h cooldown retry can pick it up.
                $this->markTerminal($ride, 'failed');
                Log::warning("AnalyzeRideSpeedJob: ride={$ride->ride_id} upstream travelDetail failed");
                return;
            }

            $data = is_array($resp['data'] ?? null) ? $resp['data'] : [];
            $trail = (string) ($data['trail'] ?? '');

            if ($trail === '') {
                $this->markTerminal($ride, 'skipped');
                Log::info("AnalyzeRideSpeedJob: ride={$ride->ride_id} skipped (empty trail)");
                return;
            }

            $apiSpeed = isset($data['speed']) ? (float) $data['speed'] : null;
            $analyzer = new SpeedAnalyzer();
            $analysis = $analyzer->analyse($trail, $apiSpeed, (float) $ride->mileage);

            // Same semantics as BackfillRideMaxSpeedCommand: only persist
            // multi_peak results as the confirmed ceiling. api_avg_fallback
            // is just the average speed — showing it as "极速" is misleading.
            $ride->max_speed_kph = $analysis['top_speed_method'] === 'multi_peak'
                ? $analysis['top_speed_kph']
                : null;
            $ride->speed_analysis_status = 'done';
            $ride->analyzed_at = now();
            $ride->save();

            Log::info("AnalyzeRideSpeedJob: ride={$ride->ride_id} speed={$analysis['top_speed_kph']} method={$analysis['top_speed_method']}");
        } catch (\Throwable $e) {
            // Never rethrow: missing failed_jobs table (or queue retry) would
            // otherwise leave the same ride cycling forever. Status is the
            // single source of truth for retry eligibility.
            $this->markTerminal($ride, 'failed');
            Log::error("AnalyzeRideSpeedJob failed for ride_id={$ride->ride_id}: {$e->getMessage()}");
        }
    }

    private function markProcessing(DeviceRideHistory $ride): void
    {
        $ride->speed_analysis_status = 'processing';
        $ride->saveQuietly();
    }

    private function markTerminal(DeviceRideHistory $ride, string $status): void
    {
        $ride->speed_analysis_status = $status;
        $ride->analyzed_at = now();
        $ride->save();
    }

    private function isSyntheticRideId(string $rideId): bool
    {
        return (bool) preg_match('/^(CYC-|OUTLIER|test-|SYN|e2e-)/i', $rideId);
    }
}
