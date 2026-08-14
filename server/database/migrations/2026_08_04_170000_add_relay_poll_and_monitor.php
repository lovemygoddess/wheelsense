<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 中继（车尾箱手机）的另外两个远程配置项：
 *
 *  - relay_poll_ms：中继轮询服务端的间隔（拉命令/拉配置），也是仪表盘
 *    刷新中继遥测的基础间隔。默认 5000ms。范围 1000–60000。
 *  - relay_monitor_secs：停车后「仍按骑行频率采样/上报」的保持时长
 *    （ride-linger）。覆盖 RideSegmenter 的 STOP_CONFIRM_MS，避免红绿灯
 *    等短暂停车被误判为停车而降频丢数据。默认 180s（= 原 3min），
 *    范围 0–600（0 = 一停即降频）。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('devices', function (Blueprint $table): void {
            $table->integer('relay_poll_ms')->nullable()->after('relay_thermo_mac');
            $table->integer('relay_monitor_secs')->nullable()->after('relay_poll_ms');
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table): void {
            $table->dropColumn(['relay_poll_ms', 'relay_monitor_secs']);
        });
    }
};
