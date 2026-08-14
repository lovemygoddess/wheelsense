<?php

namespace App\Services\Dashboard;

use App\Models\Device;
use App\Models\DeviceRideHistory;
use App\Models\DeviceRideMonthSummary;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Collection;

/**
 * Synchronizes per-month ride lists from the upstream ninecli `/travel?month=…`
 * endpoint into the local `device_ride_history` table.
 *
 * Two concerns encapsulated here:
 *  - Upserting each `list[]` row by `month + ride_id`, preserving raw payload
 *  - Reading speed figures back off that payload with the right semantics
 *    (local math for the average, `list[].speed` for the peak)
 *
 * Pure data sync — no HTTP concerns. Controllers inject this service and
 * call it; response wrapping stays in the controller via ApiResponder.
 */
class RideHistorySyncService
{
    /**
     * Physical top-speed ceiling for this vehicle (km/h). Vendor peaks above
     * it are upstream noise, not a speed record.
     */
    public const MAX_PLAUSIBLE_SPEED_KPH = 95.0;

    /**
     * Upsert one month of upstream ride rows into device_ride_history,
     * then return the locally-persisted rows ordered newest-first.
     *
     * @param  array<int, array<string, mixed>>  $upstreamList  the `list[]`
     *         payload from ninecli (possibly empty).
     * @return Collection<int, DeviceRideHistory>
     */
    public function syncMonth(Device $device, string $month, array $upstreamList): Collection
    {
        foreach ($upstreamList as $index => $ride) {
            if (! is_array($ride)) {
                continue;
            }
            // travel_id (UUID) is the ONLY stable upstream key. The old
            // positional `$index` fallback made every row's identity shift
            // whenever a new ride arrived — rows overwrote each other and
            // SUM(mileage) fluctuated, freezing the odometer display.
            $rideId = (string) ($ride['travel_id'] ?? $ride['id'] ?? $ride['ride_id'] ?? $ride['detail_id'] ?? $index);
            $payload = $ride;
            foreach (['energy', 'ec', 'used_electricity', 'electricity'] as $legacyEnergyKey) {
                unset($payload[$legacyEnergyKey]);
            }
            $device->rideHistory()->updateOrCreate(
                ['ride_id' => $month.'-'.$rideId],
                [
                    'month' => $month,
                    'started_at' => $ride['started_at'] ?? $ride['start_time'] ?? $ride['startTime'] ?? null,
                    'ended_at' => $ride['ended_at'] ?? $ride['end_time'] ?? $ride['endTime'] ?? null,
                    'mileage' => (float) ($ride['mileage'] ?? $ride['mileages'] ?? 0),
                    'payload' => $payload,
                ],
            );
        }

        return $device->rideHistory()->where('month', $month)->orderByDesc('started_at')->get();
    }

    /**
     * Upsert the authoritative per-month aggregates (times / total_mileages /
     * ec / duration) from the same travel response into
     * device_ride_month_summary. The upstream `list[]` is capped at 20 rows
     * per month — these aggregates are the ONLY complete mileage/energy
     * source and are what odometer / cycle-count math must use.
     *
     * Callers must only invoke this after verifying the upstream request
     * succeeded — an all-zero row then correctly means "month is empty"
     * (and prevents endless refetching of empty months).
     *
     * @param  array<string, mixed>  $data  the full `data` payload (not just `list`)
     */
    public function syncMonthSummary(Device $device, string $month, array $data): DeviceRideMonthSummary
    {
        return DeviceRideMonthSummary::query()->updateOrCreate(
            ['device_id' => $device->id, 'month' => $month],
            [
                'ride_count' => (int) ($data['times'] ?? 0),
                'total_mileage_km' => round((float) ($data['total_mileages'] ?? 0), 1),
                'total_duration_sec' => (int) ($data['duration'] ?? 0),
            ],
        );
    }

    /**
     * The earliest month that could contain this device's ride data:
     * min(device created_at, earliest synced ride month, earliest snapshot).
     * device.created_at alone is wrong when the device row was re-created
     * after rides already existed (June rides, July device row).
     */
    public function earliestDataMonth(Device $device): string
    {
        $candidates = [Carbon::parse($device->created_at)->format('Ym')];
        $rideMonth = DeviceRideHistory::query()->where('device_id', $device->id)->min('month');
        if (is_string($rideMonth) && $rideMonth !== '') {
            $candidates[] = $rideMonth;
        }
        $snapMonth = \App\Models\DeviceSnapshot::query()->where('device_id', $device->id)->min('created_at');
        if ($snapMonth !== null) {
            $candidates[] = Carbon::parse($snapMonth)->format('Ym');
        }
        // Bounded lookback: local evidence of older riding may be gone
        // (pruned legacy rows), while the upstream still has those months.
        // Empty months cost one fetch once and then get an all-zero row.
        $candidates[] = Carbon::now()->subMonths(12)->format('Ym');
        return min($candidates);
    }

    /**
     * Months (Ym) between the device's first appearance and now that have
     * NO summary row yet — used by the poller to self-heal history one
     * month per run, and by the backfill command to fill everything.
     *
     * @return list<string>
     */
    public function missingSummaryMonths(Device $device, ?string $fromMonth = null): array
    {
        $start = $fromMonth ?? $this->earliestDataMonth($device);
        $end = Carbon::now()->format('Ym');
        $have = DeviceRideMonthSummary::query()
            ->where('device_id', $device->id)
            ->pluck('month')
            ->flip();

        $missing = [];
        // A-25: '!Ym' zeroes unspecified fields (day=1). Plain 'Ym' lets Carbon
        // fill the day with TODAY's date, so on the 29/30/31st parsing a
        // February month overflows into March and that month's aggregation is
        // silently skipped.
        $cursor = Carbon::createFromFormat('!Ym', $start)->startOfMonth();
        $last = Carbon::createFromFormat('!Ym', $end)->startOfMonth();
        $guard = 0;
        while ($cursor <= $last && $guard++ < 240) {
            $ym = $cursor->format('Ym');
            if (! isset($have[$ym])) {
                $missing[] = $ym;
            }
            $cursor->addMonth();
        }
        return $missing;
    }

    /**
     * Cumulative km across all synced month summaries for a device — the
     * odometer delta source (replaces SUM(device_ride_history.mileage)).
     */
    public function summaryTotalKm(Device $device): float
    {
        return (float) DeviceRideMonthSummary::query()
            ->where('device_id', $device->id)
            ->sum('total_mileage_km');
    }

    /**
     * Cumulative Wh across all synced month summaries — the cycle-count
     * delta source (replaces SUM(device_ride_history.energy)).
     */
    public function summaryTotalWh(Device $device): float
    {
        return (float) \App\Models\BmsEnergyInterval::query()
            ->where('device_sn', $device->sn)
            ->sum('energy_wh');
    }

    /**
     * Average km/h for a ride row = whole-trip mileage ÷ wall-clock duration.
     *
     * Computed locally on purpose. The upstream `list[].speed` field must
     * never be used here — it is a per-ride PEAK (see vendorPeakSpeedKph),
     * so substituting it would print a top speed under a 均速 label.
     */
    public function resolveAvgSpeedKph(DeviceRideHistory $ride): ?float
    {
        if ($ride->mileage > 0 && $ride->started_at && $ride->ended_at) {
            return round(
                $ride->mileage / max(1, abs($ride->ended_at->diffInSeconds($ride->started_at))) * 3600,
                2,
            );
        }
        return null;
    }

    /**
     * The vendor's per-ride top speed, read off the stored `list[].speed`.
     *
     * This field is a MAXIMUM, not an average — confirmed against this
     * device's own history: a 0.1 km / 53 s hop reports 16 while an 18 km
     * commute reports 79, and in healthy months the value always sits above
     * distance÷duration.
     *
     * Two caveats callers must handle:
     *  - Values above the vehicle's physical ceiling are dropped here.
     *  - While the vehicle reported compliance-limited speed, the cloud got
     *    a capped figure (flat 25 across weeks of 30–39 km/h rides). That
     *    shows up as a peak BELOW the trip average; detecting it needs the
     *    average, so it is left to the caller.
     */
    public function vendorPeakSpeedKph(?DeviceRideHistory $ride): ?float
    {
        $speed = is_array($ride?->payload) ? ($ride->payload['speed'] ?? null) : null;
        if (! is_numeric($speed)) {
            return null;
        }
        $speed = (float) $speed;

        return ($speed > 0 && $speed <= self::MAX_PLAUSIBLE_SPEED_KPH) ? $speed : null;
    }
}
