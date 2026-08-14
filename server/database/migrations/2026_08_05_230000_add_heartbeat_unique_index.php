<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * The rolling phone-status row is upserted via
     * updateOrCreate(['device_sn', 'is_heartbeat' => 1], ...) — a check-then-act
     * pair with no database backing. Two concurrent flushes (batch endpoint +
     * live endpoint, or a retry racing a heartbeat) could both miss the SELECT
     * and insert a second heartbeat row, after which updateOrCreate updates
     * only the FIRST match and liveness reads split-brain.
     *
     * Mirror of the existing partial unique index on non-heartbeat rows:
     * one heartbeat row per device, enforced by SQLite itself.
     */
    public function up(): void
    {
        // Dedupe defensively before creating the index (keep the newest row
        // per device). Normally a no-op.
        DB::statement('
            DELETE FROM bms_live_snapshots
            WHERE is_heartbeat = 1
              AND id NOT IN (
                  SELECT MAX(id) FROM bms_live_snapshots
                  WHERE is_heartbeat = 1 GROUP BY device_sn
              )
        ');

        DB::statement('
            CREATE UNIQUE INDEX IF NOT EXISTS bms_live_snapshots_heartbeat_unique
            ON bms_live_snapshots (device_sn)
            WHERE is_heartbeat = 1
        ');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS bms_live_snapshots_heartbeat_unique');
    }
};
