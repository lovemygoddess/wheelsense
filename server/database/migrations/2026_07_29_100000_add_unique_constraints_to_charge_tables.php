<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Add UNIQUE constraints that make charge-event / charge-cycle creation
 * race-safe across the dual write paths (PollDevicesCommand + the
 * DeviceSnapshotObserver fallback):
 *
 *   charge_events  UNIQUE (device_sn, started_at)   — prevents double-open
 *   charge_cycles  UNIQUE (end_charge_event_id)     — prevents double-close
 *
 * The up() is defensive: it first re-points cycles away from duplicate
 * events, then removes duplicates (keep the lowest id), then creates the
 * indexes IF NOT EXISTS. Verified clean production data makes the dedup
 * steps no-ops; they exist so a dirty dev DB can migrate too.
 */
return new class extends Migration
{
    public function up(): void
    {
        // 1) Re-point cycle event references onto the surviving (lowest-id)
        //    event of each (device_sn, started_at) group. Unconditional on
        //    purpose: for non-duplicated events MIN(id) maps the id onto
        //    itself, so a "duplicates only" filter is unnecessary — and a
        //    GROUP BY + bare-id filter is unreliable in SQLite (it returns
        //    an ARBITRARY id per group, which stranded some references).
        DB::statement(<<<'SQL'
            UPDATE charge_cycles
            SET start_charge_event_id = (
                SELECT MIN(e2.id) FROM charge_events e2
                JOIN charge_events e1 ON e1.id = charge_cycles.start_charge_event_id
                WHERE e2.device_sn = e1.device_sn AND e2.started_at = e1.started_at
            )
            WHERE start_charge_event_id IS NOT NULL
        SQL);

        DB::statement(<<<'SQL'
            UPDATE charge_cycles
            SET end_charge_event_id = (
                SELECT MIN(e2.id) FROM charge_events e2
                JOIN charge_events e1 ON e1.id = charge_cycles.end_charge_event_id
                WHERE e2.device_sn = e1.device_sn AND e2.started_at = e1.started_at
            )
            WHERE end_charge_event_id IS NOT NULL
        SQL);

        // 2) Drop duplicate events (keep lowest id per device+start).
        DB::statement(<<<'SQL'
            DELETE FROM charge_events
            WHERE id NOT IN (
                SELECT MIN(id) FROM charge_events GROUP BY device_sn, started_at
            )
        SQL);

        // 3) Drop duplicate cycles (keep lowest id per end event).
        DB::statement(<<<'SQL'
            DELETE FROM charge_cycles
            WHERE end_charge_event_id IS NOT NULL
              AND id NOT IN (
                SELECT MIN(id) FROM charge_cycles
                WHERE end_charge_event_id IS NOT NULL
                GROUP BY end_charge_event_id
            )
        SQL);

        // 4) Unique indexes (SQLite allows multiple NULLs in unique indexes,
        //    so nullable end_charge_event_id rows are unaffected).
        DB::statement('CREATE UNIQUE INDEX IF NOT EXISTS charge_events_device_sn_started_at_unique ON charge_events (device_sn, started_at)');
        DB::statement('CREATE UNIQUE INDEX IF NOT EXISTS charge_cycles_end_charge_event_id_unique ON charge_cycles (end_charge_event_id)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS charge_events_device_sn_started_at_unique');
        DB::statement('DROP INDEX IF EXISTS charge_cycles_end_charge_event_id_unique');
    }
};
