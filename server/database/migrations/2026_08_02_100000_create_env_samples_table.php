<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * env_samples — 环境温湿度观测，来自小米 LYWSD03MMC（刷 pvvx 固件后广播明文）。
 *
 * 中继可在无 SIM、仅偶发联网时积攒数据并批量回传；本表与
 * bms_live_snapshots 同源但语义不同（那是电池保护板帧，这是环境气候），
 * 独立成表以免污染电池表的偏唯一索引与物理校验。device_sn + captured_at
 * 偏唯一索引保证一次中断的补传不会插出重复行。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('env_samples', function ($table): void {
            $table->id();
            $table->string('device_sn', 32);
            $table->string('sensor_mac', 17)->nullable()->comment('LYWSD03MMC MAC，多传感器区分');
            $table->float('temp_c', 5, 2)->nullable()->comment('环境温度 ℃');
            $table->float('humidity_pct', 5, 2)->nullable()->comment('环境湿度 %');
            $table->integer('sensor_battery_mv')->nullable()->comment('温湿度计自身电池 mV');
            $table->integer('rssi')->nullable()->comment('中继收到广播的 RSSI');
            $table->dateTime('captured_at')->nullable();
            $table->timestamps();
            $table->index(['device_sn', 'captured_at']);
        });

        // 补传幂等：同一设备同一时刻只保留一行。
        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS env_samples_ingest_uniq '
            . 'ON env_samples (device_sn, captured_at)'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS env_samples_ingest_uniq');
        Schema::dropIfExists('env_samples');
    }
};
