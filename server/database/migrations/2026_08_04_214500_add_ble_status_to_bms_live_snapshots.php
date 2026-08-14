<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The relay phone reports its BLE link state ("扫描中" / "未发现设备" /
     * "蓝牙权限不足" / "已连接 xxx") in the heartbeat. Surfacing it on the
     * rolling row lets the dashboard explain WHY the ANT board is unattached
     * without anyone opening the relay app on the phone in the tail box.
     */
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->string('ble_status', 120)->nullable()->after('board_connected');
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table) {
            $table->dropColumn('ble_status');
        });
    }
};
