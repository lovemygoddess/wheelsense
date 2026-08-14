<?php

namespace App\Console\Commands;

use App\Models\Device;
use App\Models\DeviceSnapshot;
use App\Services\Dashboard\VehiclePayloadMapper;
use Illuminate\Console\Command;

/**
 * Refresh cached `location_desc` rows by re-running AMap reverse geocoding
 * with the (now correct) WGS-84 → GCJ-02 conversion.
 *
 * Use after a fix that changes how `location_desc` is computed. Equivalent
 * to clearing a stale cache, but does the re-geocoding inline so the user
 * doesn't have to wait for the next 5-min poll to see fresh addresses.
 *
 * Examples:
 *   php artisan evtelemetry:clear-location-desc                       # all devices
 *   php artisan evtelemetry:clear-location-desc --device=YOUR_DEVICE_SN  # one device
 *   php artisan evtelemetry:clear-location-desc --dry-run             # count only
 *   php artisan evtelemetry:clear-location-desc --skip-regeo          # only clear, defer fill
 */
class ClearLocationDescCommand extends Command
{
    protected $signature = 'evtelemetry:clear-location-desc
        {--device= : Limit to a single device SN}
        {--dry-run : Count matching rows without modifying}
        {--skip-regeo : Just clear without re-geocoding (next poll will fill)}';

    protected $description = 'Refresh cached location_desc by re-running reverse geocoding with fixed coordinate conversion';

    public function handle(): int
    {
        $deviceId = null;
        if ($sn = $this->option('device')) {
            $deviceId = Device::where('sn', $sn)->value('id');
            if (! $deviceId) {
                $this->error("Device {$sn} not found.");
                return self::FAILURE;
            }
        }

        // Match any snapshot that could carry an address — both currently
        // cached (stale under the bug) and never-geocoded (cleared to null
        // by a previous clear-location-desc run). Both need re-encoding
        // after the WGS-84 → GCJ-02 fix.
        $q = DeviceSnapshot::query()
            ->whereNotNull('latitude')
            ->whereNotNull('longitude');

        if ($deviceId !== null) {
            $q->where('device_id', $deviceId);
        }

        $count = $q->count();
        if ($count === 0) {
            $this->info('No snapshots with coordinates found — nothing to refresh.');
            return self::SUCCESS;
        }

        $verb = $this->option('dry-run') ? 'Would refresh' : 'Will refresh';
        $this->line("$verb location_desc on <info>$count</info> snapshots (includes both cached and null).");
        if ($this->option('dry-run')) {
            return self::SUCCESS;
        }

        if (! $this->confirm("Confirm refreshing $count rows?", true)) {
            $this->warn('Aborted, no changes made.');
            return self::SUCCESS;
        }

        // Collect snapshots and group by rounded (lat, lng) to minimize HTTP
        // calls. Round to 4 decimal places (~11m) so jitter from GPS noise
        // doesn't make every snapshot a unique "location". We keep IDs too
        // — they're the only reliable way to UPDATE later, because SQLite's
        // ROUND with PDO-bound placeholders coerces numeric types and breaks
        // equality compare (verified: ROUND(?) with bound float returns 0).
        $rows = $q->get();
        $pairs = $rows
            ->map(fn ($s) => [
                'id' => $s->id,
                'lat' => round((float) $s->latitude, 4),
                'lng' => round((float) $s->longitude, 4),
            ])
            ->groupBy(fn ($p) => $p['lat'] . ',' . $p['lng'])
            ->map(fn ($group) => [
                'ids' => $group->pluck('id')->all(),
                'lat' => $group[0]['lat'],
                'lng' => $group[0]['lng'],
            ])
            ->values();

        $this->line("Unique location pairs to re-encode: <info>" . $pairs->count() . "</info>");
        $this->line('Estimated AMap Regeo calls: <info>' . $pairs->count() . '</info>');

        // Clear all address rows first so even if regeo fails midway,
        // we don't leave stale addresses around. snapshotPayload will lazy-
        // fill these back if regeo is skipped.
        DeviceSnapshot::query()
            ->when($deviceId !== null, fn ($qq) => $qq->where('device_id', $deviceId))
            ->whereNotNull('latitude')
            ->whereNotNull('longitude')
            ->update(['location_desc' => null]);

        if ($this->option('skip-regeo')) {
            $this->info("Cleared location_desc on $count snapshots. Next API read will re-geocode.");
            return self::SUCCESS;
        }

        // Re-encode in bulk via the same logic the payload mapper uses, so the
        // fix stays in lockstep with what /api/dashboard/vehicles produces.
        // NOTE: reverseGeocode() lives on VehiclePayloadMapper (private), NOT on
        // DashboardController — reflecting the controller threw ReflectionException
        // and crashed this command 100% of the time without --skip-regeo.
        $mapper = app(VehiclePayloadMapper::class);
        $reflection = new \ReflectionMethod($mapper, 'reverseGeocode');
        $reflection->setAccessible(true);

        $bar = $this->output->createProgressBar($pairs->count());
        $bar->start();

        $ok = 0; $fail = 0;
        $cache = []; // "lat,lng" → formatted address

        foreach ($pairs as $pair) {
            $key = $pair['lat'] . ',' . $pair['lng'];
            $desc = $reflection->invoke($mapper, (float) $pair['lat'], (float) $pair['lng']);
            $cache[$key] = $desc;
            if ($desc !== null) {
                $ok++;
            } else {
                $fail++;
            }
            // Throttle AMap: ~50ms delay between calls
            usleep(50_000);
            $bar->advance();
        }
        $bar->finish();
        $this->newLine();

        // Update rows by ID — sidesteps SQLite/PDO type-coercion issues
        // with rounded-coord equality compares.
        $updated = 0;
        foreach ($pairs as $pair) {
            $key = $pair['lat'] . ',' . $pair['lng'];
            $desc = $cache[$key] ?? null;
            $u = DeviceSnapshot::query()->whereIn('id', $pair['ids'])->update(['location_desc' => $desc]);
            $updated += $u;
        }

        $this->info("Refreshed: <info>$updated</info> rows updated across <info>" . count($cache) . "</info> unique locations.");
        $this->line("Successful geocodes: $ok, failed: $fail");

        return self::SUCCESS;
    }
}
