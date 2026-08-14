<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Rewrites bms_live_snapshots.captured_at from UTC digits into app-local time.
 *
 * The relay (and the dashboard's BMS tab) both send `new Date().toISOString()`,
 * i.e. "2000-01-01T03:03:54Z". Laravel's datetime cast parses that into a
 * UTC-zoned Carbon and then formats it verbatim, so the column ended up
 * holding UTC digits while `created_at` — and every other datetime column in
 * this database — holds the configured application timezone. Example:
 *
 *     id  captured_at          created_at
 *     1  2000-01-01 03:03:54  2000-01-01 11:03:54   ← same instant, 8h apart
 *
 * Until now that only produced cosmetic weirdness (relayStatus deliberately
 * measures liveness by created_at precisely to dodge it, and index()'s
 * age_seconds has been 8h wrong all along). It becomes a correctness problem
 * the moment offline ride sessions are matched against device_ride_history by
 * time overlap: every match would miss by eight hours.
 *
 * Every row in this table was written by the relay or the app, both in UTC,
 * so a uniform shift is safe. Asia/Shanghai has had no DST since 1991, which
 * is why a single fixed offset is exact rather than an approximation; the
 * offset is read from config rather than hardcoded so a timezone change
 * doesn't silently produce a wrong constant.
 */
return new class extends Migration
{
    public function up(): void
    {
        $offsetSeconds = $this->appOffsetSeconds();
        if ($offsetSeconds === 0) {
            return;
        }

        $sign = $offsetSeconds > 0 ? '+' : '-';
        $magnitude = abs($offsetSeconds);

        DB::statement(
            'UPDATE bms_live_snapshots SET captured_at = '
            . "datetime(captured_at, '{$sign}{$magnitude} seconds') "
            . 'WHERE captured_at IS NOT NULL'
        );
    }

    public function down(): void
    {
        $offsetSeconds = $this->appOffsetSeconds();
        if ($offsetSeconds === 0) {
            return;
        }

        // Inverse shift.
        $sign = $offsetSeconds > 0 ? '-' : '+';
        $magnitude = abs($offsetSeconds);

        DB::statement(
            'UPDATE bms_live_snapshots SET captured_at = '
            . "datetime(captured_at, '{$sign}{$magnitude} seconds') "
            . 'WHERE captured_at IS NOT NULL'
        );
    }

    /** Seconds the app timezone runs ahead of UTC. */
    private function appOffsetSeconds(): int
    {
        $tz = (string) config('app.timezone', 'UTC');

        try {
            $zone = new DateTimeZone($tz);
        } catch (\Throwable) {
            return 0;
        }

        return (new DateTime('now', $zone))->getOffset();
    }
};
