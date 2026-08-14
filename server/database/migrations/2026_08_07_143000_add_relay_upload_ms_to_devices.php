<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 动态上行间隔：仪表板按「GPS 启用 + 骑行中」驱动中继向服务端推送保护板帧的节奏。
 *  - 激进（GPS 开 + 骑行中）：1000ms
 *  - 缓慢（其余）：5000ms
 * 设备上此列缺省 3000ms（温和中间值），由 DashboardController::relayStatus 按上报状态写入。
 * 中继通过 /relay/config 拉取 upload_ms 并套用到 HttpRelay 的上行节流。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->integer('relay_upload_ms')->nullable()->default(3000);
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->dropColumn('relay_upload_ms');
        });
    }
};
