<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 中继（车尾箱手机）的可远程配置项。
 *
 * 这些值是「服务端按设备存储、中继每次轮询拉取」的真相源——中继本机
 * Prefs 里的 sensorMac 等仍作为兜底，但 App 设置页改的是这里。
 *
 *  - relay_sample_idle_ms：停车时 GPS 采样间隔（默认 600000 = 10min，仅保活星历）
 *  - relay_sample_ride_ms：骑行时 GPS 采样间隔（默认 1000 = 1Hz）
 *  - relay_low_power：手动低功耗（节流 GPS，省电），默认关
 *  - relay_thermo_mac：温湿度计 MAC（中继被动监听用），可空
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('devices', function (Blueprint $table): void {
            $table->integer('relay_sample_idle_ms')->nullable()->after('raw');
            $table->integer('relay_sample_ride_ms')->nullable()->after('relay_sample_idle_ms');
            $table->boolean('relay_low_power')->default(false)->after('relay_sample_ride_ms');
            $table->string('relay_thermo_mac', 17)->nullable()->after('relay_low_power');
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table): void {
            $table->dropColumn([
                'relay_sample_idle_ms',
                'relay_sample_ride_ms',
                'relay_low_power',
                'relay_thermo_mac',
            ]);
        });
    }
};
