<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Provenance tag for bms_live_snapshots rows.
 *
 * Two different phones can feed this table for the same vehicle:
 *
 *  - the dedicated relay in the tail box, which posts via POST /api/relay/batch
 *    (its only path — BatchUploader); tagged 'relay'.
 *  - a dashboard phone, whose BMS tab can read the board
 *    over its own BLE and posts via POST /api/bms-live-snapshot; tagged 'phone'.
 *
 * DashboardController::relayLiveBms / relayStatus must know which is which:
 * the dashboard's "prefer the relay" arbitration keys off board_fresh, and if
 * the dashboard phone's OWN upload counted toward board_fresh it would flip the
 * screen into "relay mode" using data it provided itself — mislabeling it as
 * relay data and disconnecting the phone's BLE in a connect/freeze flap. Scoping the
 * arbitration to source='relay' closes that self-feedback loop.
 *
 * Existing rows are left NULL: they predate the tag, are all stale (board_fresh
 * only cares about the last 60 s), and the relay-exclusive heartbeat row is
 * matched by is_heartbeat = 1 regardless of source.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->string('source', 16)->nullable()
                ->comment('ingestion origin: relay (/relay/batch) | phone (dashboard /bms-live-snapshot)');
            // relayLiveBms filters device_sn + source + crc_ok and orders by
            // created_at; this composite keeps that lookup narrow.
            $table->index(['device_sn', 'source']);
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->dropIndex(['device_sn', 'source']);
            $table->dropColumn('source');
        });
    }
};
