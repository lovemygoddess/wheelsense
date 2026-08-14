<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Remove legacy orphan charge_cycles whose charge-event anchors are NULL.
 *
 * These were created before the 2026_07_29_100000 unique-constraints
 * migration, and that migration's dedup step only handled rows with a
 * NON-NULL end_charge_event_id (it filtered `end_charge_event_id IS NOT
 * NULL`), so the NULL-anchor orphans survived. An orphan shares an identical
 * (start_at, end_at) window with the real cycle but carries bogus NULL
 * anchors and a wrong mileage, and its voltage_samples duplicate the real
 * cycle's — polluting SOC-curve fitting.
 *
 * Also add a defensive UNIQUE(device_sn, start_at, end_at) so a cycle can
 * never be emitted twice for the same bounding charge events again.
 *
 * up() is safe to re-run: the deletes target only NULL-anchor orphans, and
 * the index is created IF NOT EXISTS.
 */
return new class extends Migration
{
    public function up(): void
    {
        // 1) Drop voltage_samples tied to orphan cycles first (no FK cascade).
        DB::statement(<<<'SQL'
            DELETE FROM voltage_samples
            WHERE cycle_id IN (
                SELECT id FROM charge_cycles WHERE end_charge_event_id IS NULL
            )
        SQL);

        // 2) Drop the orphan cycles themselves.
        DB::statement(<<<'SQL'
            DELETE FROM charge_cycles WHERE end_charge_event_id IS NULL
        SQL);

        // 3) Defensive unique index over the cycle's bounding window.
        //    (device_sn, start_at, end_at) are all NOT NULL on created rows,
        //    so SQLite's "multiple NULLs allowed in unique" rule never applies.
        DB::statement('CREATE UNIQUE INDEX IF NOT EXISTS charge_cycles_device_sn_start_end_unique ON charge_cycles (device_sn, start_at, end_at)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS charge_cycles_device_sn_start_end_unique');
    }
};
