<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The relay phone reports screen-on/off in the heartbeat (via
     * PowerManager.isInteractive on Android 8). A lit screen means the relay
     * app is foreground/visible (extra drain + heat); OFF means headless in the
     * tail box. Lets the dashboard show "why is the relay warm" without opening
     * the app on the relay phone.
     */
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->boolean('phone_screen_on')->nullable()->after('phone_battery_voltage_v');
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->dropColumn('phone_screen_on');
        });
    }
};
