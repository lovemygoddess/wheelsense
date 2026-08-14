<?php

namespace App\Console\Commands;

use App\Models\BatteryCalibration;
use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Services\Dashboard\RideHistorySyncService;
use App\Services\NinebotApiService;
use Carbon\Carbon;
use Illuminate\Console\Command;

/**
 * Backfill device_ride_month_summary from the upstream travel endpoint for
 * every month since each device appeared, then migrate the odometer /
 * cycle-count baselines onto the authoritative aggregates.
 *
 * Why this exists: the upstream ride `list[]` is capped at 20 rows per
 * month, so SUM(device_ride_history) silently undercounts (~80% missing).
 * Worse, pre-fix rows were keyed positionally (202607-0…) and overwrote
 * each other as new rides arrived. Odometer/cycle math must use the
 * monthly aggregates (times / total_mileages / ec) instead.
 *
 * Safe to re-run: everything is upsert/idempotent.
 */
class SyncRideMonthsCommand extends Command
{
    protected $signature = 'evtelemetry:sync-ride-months
        {--device= : only this device sn}
        {--from= : earliest month Ym (default: device created_at month)}
        {--dry-run : show what would change without writing}';

    protected $description = 'Backfill monthly ride aggregates from upstream and migrate odometer/cycle baselines';

    public function __construct(
        private readonly NinebotApiService $ninebotApi,
        private readonly RideHistorySyncService $rideSync,
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $dry = (bool) $this->option('dry-run');
        $devices = Device::query()
            ->when($this->option('device'), fn ($q, $sn) => $q->where('sn', $sn))
            ->get();

        foreach ($devices as $device) {
            // Capture the authoritative sums BEFORE syncing so migrateBaselines
            // can shift the anchors by exactly the delta (display-preserving).
            $prev = $this->authoritativeSums($device);
            $this->syncDevice($device, $dry);
            $this->migrateBaselines($device, $dry, $prev);
            $this->prunePositionalRows($device, $dry);
        }

        $this->info($dry ? 'Dry run complete.' : 'Sync complete.');
        return self::SUCCESS;
    }

    private function syncDevice(Device $device, bool $dry): void
    {
        $from = $this->option('from') ?: $this->rideSync->earliestDataMonth($device);
        // A-25: '!Ym' zeroes the day to 1; plain 'Ym' would use today's day
        // and overflow February into March when run on the 29/30/31st.
        $cursor = Carbon::createFromFormat('!Ym', $from)->startOfMonth();
        $last = Carbon::now()->startOfMonth();

        $this->line("== {$device->sn} ({$device->device_name}) from {$from} ==");

        $guard = 0;
        while ($cursor <= $last && $guard++ < 240) {
            $ym = $cursor->format('Ym');
            $cursor->addMonth();

            if ($dry) {
                $this->line("  would fetch {$ym}");
                continue;
            }

            $travel = $this->ninebotApi->travel($device->sn, $ym);
            if (($travel['ok'] ?? false) !== true) {
                $this->warn("  {$ym}: upstream failed, skipped");
                continue;
            }
            $data = is_array($travel['data'] ?? null) ? $travel['data'] : [];
            $list = is_array($data['list'] ?? null) ? $data['list'] : [];
            $this->rideSync->syncMonth($device, $ym, $list);
            $row = $this->rideSync->syncMonthSummary($device, $ym, $data);
            $this->line(sprintf(
                '  %s: times=%d km=%.1f (list rows=%d)',
                $ym, $row->ride_count, $row->total_mileage_km, count($list)
            ));
        }
    }

    /**
     * Authoritative cumulative sums from device_ride_month_summary.
     *
     * @return array{km: float, wh: float}
     */
    private function authoritativeSums(Device $device): array
    {
        return [
            'km' => round((float) \App\Models\DeviceRideMonthSummary::query()
                ->where('device_id', $device->id)->sum('total_mileage_km'), 1),
            'wh' => round((float) \App\Models\BmsEnergyInterval::query()
                ->where('device_sn', $device->sn)->sum('energy_wh'), 3),
        ];
    }

    /**
     * Re-anchor the stored baselines after a re-sync WITHOUT moving the
     * displayed values. display = baseline + (authoritative_sum − anchor),
     * so when the sync changes the authoritative sum by Δ, the anchor must
     * shift by the SAME Δ — the old code pinned anchor = current sum, which
     * reset display to the bare baseline and wiped every km the user had
     * ridden since entering it (P1 data-loss bug).
     *
     * @param  array{km: float, wh: float}  $prev  sums captured before syncDevice()
     */
    private function migrateBaselines(Device $device, bool $dry, array $prev): void
    {
        $cal = BatteryCalibration::query()->where('device_sn', $device->sn)->first();
        if ($cal === null) return;

        $sum = $this->authoritativeSums($device);
        $deltaKm = round($sum['km'] - $prev['km'], 1);
        $deltaWh = round($sum['wh'] - $prev['wh'], 1);

        if ($cal->odometer_baseline_km !== null) {
            $oldAnchor = $cal->odometer_baseline_ride_km !== null
                ? (float) $cal->odometer_baseline_ride_km
                : null;
            // null anchor (baseline set before this column existed): initialize
            // so display starts exactly at the entered baseline.
            $newAnchor = $oldAnchor === null ? $sum['km'] : round($oldAnchor + $deltaKm, 1);
            $displayBefore = round((float) $cal->odometer_baseline_km + max(0.0, $prev['km'] - ($oldAnchor ?? $prev['km'])), 1);
            $displayAfter = round((float) $cal->odometer_baseline_km + max(0.0, $sum['km'] - $newAnchor), 1);
            $this->line(sprintf(
                '  odometer baseline %.1f km: anchor %.1f → %.1f (sum Δ%+.1f, display %.1f → %.1f)',
                $cal->odometer_baseline_km, $oldAnchor ?? 0.0, $newAnchor, $deltaKm, $displayBefore, $displayAfter
            ));
            if (! $dry) $cal->odometer_baseline_ride_km = $newAnchor;
        }

        if ($cal->cycle_count_baseline !== null) {
            $oldAnchorWh = $cal->cycle_count_baseline_wh !== null
                ? (float) $cal->cycle_count_baseline_wh
                : null;
            $newAnchorWh = $oldAnchorWh === null ? $sum['wh'] : round($oldAnchorWh + $deltaWh, 1);
            $this->line(sprintf(
                '  cycle baseline %d: wh anchor %.1f → %.1f (sum Δ%+.1f, display stays %d)',
                $cal->cycle_count_baseline, $oldAnchorWh ?? 0.0, $newAnchorWh, $deltaWh, $cal->cycle_count_baseline
            ));
            if (! $dry) $cal->cycle_count_baseline_wh = $newAnchorWh;
        }

        if (! $dry) $cal->save();
    }

    /**
     * Delete pre-fix positionally-keyed rows (`202607-0`…, ≤10 chars) now
     * replaced by stable travel_id-keyed rows (24-char UUID). These stale
     * rows shuffled data on every sync and poisoned every SUM over the table.
     */
    private function prunePositionalRows(Device $device, bool $dry): void
    {
        $query = DeviceRideHistory::query()
            ->where('device_id', $device->id)
            ->whereRaw('LENGTH(ride_id) <= 10');
        $n = $query->count();
        $this->line("  positional-key rows to prune: {$n}");
        if (! $dry && $n > 0) {
            $query->delete();
        }
    }
}
