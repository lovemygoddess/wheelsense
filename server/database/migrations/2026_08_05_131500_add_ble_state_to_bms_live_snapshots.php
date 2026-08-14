<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The relay phone reports the BLE state-machine label (STOPPED / IDLE /
     * BT_OFF / SCANNING / CONNECTING / CONNECTED / BACKOFF) in the heartbeat.
     * Unlike ble_status (human text) this is a stable enum for remote
     * diagnostics — it lets the dashboard tell "relay offline" apart from
     * "relay online but scan never started" (stuck at STOPPED/IDLE) without
     * anyone opening the app on the relay phone in the tail box.
     */
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->string('ble_state', 32)->nullable()->after('ble_status');
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->dropColumn('ble_state');
        });
    }
};
