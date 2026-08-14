<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * A-37: two migrations created semantically identical heartbeat partial
     * unique indexes — 2026_07_30_213500 (bms_live_snapshots_heartbeat_uniq)
     * and 2026_08_05_230000 (bms_live_snapshots_heartbeat_unique). Both enforce
     * "one heartbeat row per device_sn where is_heartbeat = 1". Maintaining two
     * doubles the index-update cost on every upsert and risks split-brain
     * divergence. Drop the older uniq one; the tracked 2026_08_05 migration
     * owns heartbeat_unique going forward.
     */
    public function up(): void
    {
        DB::statement('DROP INDEX IF EXISTS bms_live_snapshots_heartbeat_uniq');
    }

    public function down(): void
    {
        DB::statement('
            CREATE UNIQUE INDEX IF NOT EXISTS bms_live_snapshots_heartbeat_uniq
            ON bms_live_snapshots (device_sn)
            WHERE is_heartbeat = 1
        ');
    }
};
