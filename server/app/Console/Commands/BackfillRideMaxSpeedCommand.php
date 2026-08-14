<?php

namespace App\Console\Commands;

use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Services\NinebotApiService;
use App\Services\SpeedAnalyzer;
use Illuminate\Console\Command;

/**
 * Backfill `device_ride_history.max_speed_kph` by fetching each ride's
 * `trail` field from /vehicles/{sn}/travel/{travel_id} and running the
 * multi-peak top-speed analysis.
 *
 * The algorithm finds local maxima in the speed curve, clusters peaks
 * within ±5 km/h, and—if 2+ peaks share a ceiling—takes their mean as
 * the "true" top speed.  This is more robust than the old max(positive)
 * approach because it exploits the fact that real speed limits repeat
 * while noise doesn't.  Falls back to the upstream API average speed
 * when no multi-peak pattern is found.
 *
 * Why a separate command: the upstream detail endpoint returns ~14KB
 * per ride (200-430 GPS samples). Doing all 94+ rides at once would
 * burst ~1.3MB of HTTP traffic; we throttle to keep the ninecli
 * proxy + upstream API cool.
 *
 * Default rate limit:
 *   - 2 rides per invocation
 *   - Designed to be called from the scheduler (every 5 min), so
 *     a full 94-ride backfill takes ~47 cycles ≈ 4 hours.
 *
 * Override with --limit for catch-up runs:
 *   php artisan evtelemetry:backfill-ride-max-speed --limit=10 --device=YOUR_DEVICE_SN
 *
 * Verification of col4 semantics lives in SpeedAnalyzerTest.
 */
class BackfillRideMaxSpeedCommand extends Command
{
    protected $signature = 'evtelemetry:backfill-ride-max-speed
        {--device= : Limit to a single device SN}
        {--limit=2 : Max rides to process per invocation}
        {--dry-run : Report what would be done without updating}
        {--force : Re-process rides that already have a max_speed_kph}';

    protected $description = 'Backfill per-ride max_speed_kph from upstream trail data (throttled; safe to call from scheduler)';

    public function handle(NinebotApiService $api): int
    {
        $limit = max(1, (int) $this->option('limit'));
        $deviceSn = $this->option('device');
        $dryRun = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');

        $q = DeviceRideHistory::query()->orderBy('id');
        if ($deviceSn) {
            $deviceId = Device::where('sn', $deviceSn)->value('id');
            if (! $deviceId) {
                $this->error("Device $deviceSn not found.");
                return self::FAILURE;
            }
            $q->where('device_id', $deviceId);
        }
        if (! $force) {
            $q->whereNull('max_speed_kph')
              ->where(function ($query) {
                  // 只处理未分析过（NULL）或排队中（pending）的。done/failed/skipped
                  // 是终态，不再重试——否则头部失败 ride 会反复命中 orderBy('id')+limit，
                  // 后面的 ride 永远排不到（队列饿死）。
                  $query->whereNull('speed_analysis_status')
                        ->orWhere('speed_analysis_status', 'pending');
              });
        }
        // Synthetic bootstrap rows never have upstream trails.
        $q->where('ride_id', 'not like', 'CYC-%')
          ->where('ride_id', 'not like', 'OUTLIER%')
          ->where('ride_id', 'not like', 'test-%')
          ->where('ride_id', 'not like', 'SYN%')
          ->where('ride_id', 'not like', 'e2e-%');

        $total = (clone $q)->count();
        $batch = $q->limit($limit)->get();
        $this->line("Total rides to process: $total, this invocation: " . $batch->count() . " (limit=$limit)");

        if ($batch->isEmpty()) {
            $this->info('Nothing to do.');
            return self::SUCCESS;
        }

        $ok = 0; $fail = 0;
        foreach ($batch as $ride) {
            $deviceSn = Device::where('id', $ride->device_id)->value('sn');
            if (! $deviceSn) {
                $this->warn("ride_id={$ride->id}  no device SN, skipping");
                $fail++;
                continue;
            }

            // The local `ride_id` column is a synthetic key (e.g. "202606-0"
            // for the legacy batch of 40 pre-backfill rows). The real
            // upstream UUID lives in `payload.travel_id` and is what the
            // /travel/{travel_id} detail endpoint actually accepts.
            $upstreamId = is_array($ride->payload) ? ($ride->payload['travel_id'] ?? null) : null;
            if (! $upstreamId) {
                $this->warn("ride_id={$ride->id}  no payload.travel_id, marking done (no upstream id to fetch)");
                $ride->speed_analysis_status = 'done';
                $ride->analyzed_at = now();
                $ride->save();
                $fail++;
                continue;
            }

            if ($dryRun) {
                $this->line("  would fetch: $deviceSn travel/$upstreamId  →  multi-peak top-speed analysis");
                $ok++;
                continue;
            }

            try {
                $resp = $api->travelDetail($deviceSn, $upstreamId);
                $data = $resp['data'] ?? null;
                if (!$data || empty($data['trail'])) {
                    $this->warn("ride_id={$ride->id}  upstream=$upstreamId  no trail in response, marking done");
                    $ride->speed_analysis_status = 'done';
                    $ride->analyzed_at = now();
                    $ride->save();
                    $fail++;
                    continue;
                }

                $analyzer = new SpeedAnalyzer();
                $analysis = $analyzer->analyse(
                    $data['trail'],
                    isset($data['speed']) ? (float) $data['speed'] : null,
                    (float) $ride->mileage,
                );
                $maxSpeed = $analysis['top_speed_kph'];
                $method = $analysis['top_speed_method'];

                // Only persist multi_peak results — the api_avg_fallback
                // value is just the average speed (not a real top speed)
                // and showing it as "极速" in the ride list is misleading.
                // NULL means "no confirmed speed ceiling".
                // Only persist multi_peak results as the confirmed speed ceiling.
                // Other methods (api_avg_fallback / no_peak) leave max_speed_kph NULL
                // but still mark status='done' so the ride isn't retried every cycle —
                // that was the queue-starvation bug (orderBy('id')+limit + no marker).
                $ride->max_speed_kph = $method === 'multi_peak' ? $maxSpeed : null;
                $ride->speed_analysis_status = 'done';
                $ride->analyzed_at = now();
                $ride->save();
                $apiSpeed = $data['speed'] ?? '?';
                $this->line("ride_id={$ride->id}  {$deviceSn}/{$upstreamId}  →  top_speed=" . ($method === 'multi_peak' ? "{$maxSpeed} km/h" : 'NULL') . " (method={$method}, api_speed={$apiSpeed})");
                $ok++;
            } catch (\Throwable $e) {
                $this->warn("ride_id={$ride->id}  fetch failed: " . $e->getMessage());
                // Mark failed (one-shot terminal state — not retried by this command,
                // avoids starvation. Rerun with --force to retry transient failures).
                $ride->speed_analysis_status = 'failed';
                $ride->analyzed_at = now();
                $ride->save();
                $fail++;
            }

            // Throttle: ~50ms between detail calls. ninecli upstream rate limit
            // is unknown but being polite is cheap.
            usleep(50_000);
        }

        $remaining = max(0, $total - $batch->count());
        $this->info("Done. ok=$ok  fail=$fail  remaining=$remaining");
        if ($remaining > 0) {
            $nextCycles = (int) ceil($remaining / $limit);
            $this->line("(at $limit per cycle, ~{$nextCycles} more cycles to clear the queue)");
        }

        return self::SUCCESS;
    }
}
