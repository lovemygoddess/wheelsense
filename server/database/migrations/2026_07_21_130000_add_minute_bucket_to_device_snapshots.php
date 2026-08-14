<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Idempotent column add.
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(device_snapshots)"));
        if (! in_array('minute_bucket', $columns, true)) {
            Schema::table('device_snapshots', function ($table): void {
                $table->dateTime('minute_bucket')->nullable()->after('device_id');
            });
        }

        // Backfill always (cheap, safe).
        DB::statement("
            UPDATE device_snapshots
               SET minute_bucket = strftime('%Y-%m-%d %H:%M:00', created_at)
             WHERE minute_bucket IS NULL
        ");

        // Deduplicate before applying unique index.
        DB::statement("
            DELETE FROM device_snapshots
             WHERE id IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY device_id, minute_bucket
                               ORDER BY id DESC
                           ) AS rn
                      FROM device_snapshots
                ) t
                WHERE rn > 1
             )
        ");

        // Idempotent unique index.
        $indices = array_map(fn ($i) => $i->name, DB::select("PRAGMA index_list(device_snapshots)"));
        if (! in_array('device_snapshots_dedupe_unique', $indices, true)) {
            DB::statement('CREATE UNIQUE INDEX device_snapshots_dedupe_unique ON device_snapshots (device_id, minute_bucket)');
        }
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS device_snapshots_dedupe_unique');
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(device_snapshots)"));
        if (in_array('minute_bucket', $columns, true)) {
            // SQLite ALTER TABLE DROP COLUMN is supported on modern versions.
            try {
                DB::statement('ALTER TABLE device_snapshots DROP COLUMN minute_bucket');
            } catch (\Throwable) {
                // Older SQLite without DROP COLUMN support — leave it.
            }
        }
    }
};
