<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Adds relay-liveness fields to bms_live_snapshots.
 *
 *  - board_connected:  relay-reported ANT board attachment at report time.
 *                      Lets the dashboard distinguish "relay online but board
 *                      not attached" from "relay offline" without guessing
 *                      from whether board data happened to arrive.
 *  - is_heartbeat:     marks the phone-status heartbeat row. The relay posts
 *                      one of these every ~15s even when no BMS frame arrives,
 *                      so the dashboard can show the relay phone as online
 *                      independent of board connection. A partial unique index
 *                      keeps exactly ONE heartbeat row per device (upserted),
 *                      so the steady heartbeat can't grow the table unbounded.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->boolean('board_connected')->default(0)->comment('relay-reported ANT board attachment');
            $table->boolean('is_heartbeat')->default(0)->comment('phone-status heartbeat row (upserted, one per device)');
            $table->index(['device_sn', 'is_heartbeat']);
        });

        // SQLite partial unique index: at most one row per device_sn where
        // is_heartbeat = 1. Heartbeats upsert this row instead of appending.
        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS bms_live_snapshots_heartbeat_uniq '
            . 'ON bms_live_snapshots (device_sn) WHERE is_heartbeat = 1'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS bms_live_snapshots_heartbeat_uniq');
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->dropIndex(['device_sn', 'is_heartbeat']);
            $table->dropColumn(['board_connected', 'is_heartbeat']);
        });
    }
};
