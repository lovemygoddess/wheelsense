<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Offline-first relay support for bms_live_snapshots.
 *
 * The relay phone now lives in the scooter tail box with NO SIM card. It
 * buffers everything locally and flushes the backlog the next time the
 * a configured network appears, which breaks two assumptions baked into this
 * table:
 *
 *  1. "created_at ≈ captured_at". A batch flushed after two days writes
 *     rows with created_at = now() but captured_at = two days ago.
 *     DashboardController::relayStatus measures liveness by created_at
 *     (deliberately — see that method), so a backfill flush would make the
 *     dashboard claim the relay is online right now when it is actually
 *     parked and offline. `is_backfill` marks those rows so liveness
 *     queries can exclude them.
 *
 *  2. "every row is a board frame". The relay now also records GPS-only
 *     rows (movement detected while the board is detached — the theft
 *     signal) and carries per-frame position, so the frame columns alone
 *     can no longer describe a row.
 *
 * Also adds `cycle_capacity_ah`: the ANT board's hardware coulomb counter,
 * previously parsed and thrown away. It is the only true charge-throughput
 * measurement available and is immune to the SOC-curve distortion that
 * makes the vendor `ec` field unusable.
 *
 * Finally, a partial unique index on (device_sn, captured_at) makes batch
 * ingestion idempotent: a flush interrupted mid-way can be retried whole
 * without duplicating rows. It is partial (is_heartbeat = 0) because the
 * single upserted heartbeat row keeps rewriting its captured_at and would
 * otherwise collide with a board frame captured in the same second.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            // Row provenance ------------------------------------------------
            $table->boolean('is_backfill')->default(0)
                ->comment('row arrived in a delayed batch — excluded from liveness checks');
            $table->boolean('gps_only')->default(0)
                ->comment('movement recorded with no board frame (board detached / theft signal)');
            $table->boolean('clock_disciplined')->default(0)
                ->comment('captured_at came from a GPS-corrected clock (no SIM ⇒ no NTP)');
            $table->boolean('riding')->default(0)
                ->comment('relay believed the vehicle was moving when this row was captured');

            // ANT hardware coulomb counter ----------------------------------
            $table->float('cycle_capacity_ah')->nullable()
                ->comment('board lifetime charge throughput (Ah) — true measurement, not SOC-derived');

            // Position ------------------------------------------------------
            $table->double('gps_lat')->nullable();
            $table->double('gps_lon')->nullable();
            $table->float('gps_speed_mps')->nullable()->comment('Doppler speed, not coordinate differencing');
            $table->float('gps_accuracy_m')->nullable();
            $table->float('gps_altitude_m')->nullable();
            $table->float('gps_bearing_deg')->nullable();

            // Relay backlog depth (heartbeat rows only) ----------------------
            $table->integer('pending_rows')->nullable()
                ->comment('rows still queued on the phone at heartbeat time');

            // relayStatus and the backfill sweep both filter on this pair.
            $table->index(['device_sn', 'is_backfill']);
        });

        // Idempotent ingestion key. Existing rows may already contain
        // duplicates (the old endpoint appended blindly), so collapse them
        // first — keeping the lowest id — or the index creation fails.
        DB::statement(
            'DELETE FROM bms_live_snapshots WHERE id NOT IN ('
            . '  SELECT MIN(id) FROM bms_live_snapshots'
            . '  WHERE is_heartbeat = 0'
            . '  GROUP BY device_sn, captured_at'
            . ') AND is_heartbeat = 0'
        );

        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS bms_live_snapshots_ingest_uniq '
            . 'ON bms_live_snapshots (device_sn, captured_at) WHERE is_heartbeat = 0'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS bms_live_snapshots_ingest_uniq');
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->dropIndex(['device_sn', 'is_backfill']);
            $table->dropColumn([
                'is_backfill',
                'gps_only',
                'clock_disciplined',
                'riding',
                'cycle_capacity_ah',
                'gps_lat',
                'gps_lon',
                'gps_speed_mps',
                'gps_accuracy_m',
                'gps_altitude_m',
                'gps_bearing_deg',
                'pending_rows',
            ]);
        });
    }
};
