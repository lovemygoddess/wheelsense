<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * tpms_captures — Z07 胎压/胎温传感器的原始 BLE 广播抓包（调试用）。
 *
 * 中继锁在尾箱、本身是唯一的 BLE 扫描器，被动抓到 Z07 传感器（前轮
 * Z07FFHTW2KYZ / 后轮 Z07G0GNSZCPY）的完整广播 PDU，连同厂商数据、服务数据
 * 一起回传，落到本表，便于离线逆出压力/温度的编码格式。这是 Task #9 落地解析
 * 字段之前的临时落点；之后会被解析后的结构化字段取代。
 *
 * device_sn + sensor_name + captured_at 偏唯一索引保证一次中断的补传不会插出
 * 重复行。raw_bytes 以 base64 原样保存，是解码的权威来源。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tpms_captures', function ($table): void {
            $table->id();
            $table->string('device_sn', 32);
            $table->string('sensor_name', 32)->comment('Z07... 传感器名，区分前后轮');
            $table->integer('rssi')->nullable()->comment('中继收到广播的 RSSI');
            $table->text('raw_bytes')->nullable()->comment('完整广播 PDU (base64)');
            $table->text('manufacturer_data')->nullable()->comment('厂商数据 JSON map');
            $table->text('service_data')->nullable()->comment('服务数据 JSON map');
            $table->dateTime('captured_at')->nullable();
            $table->timestamps();
            $table->index(['device_sn', 'sensor_name', 'captured_at']);
        });

        // 补传幂等：同一设备同一传感器同一时刻只保留一行。
        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS tpms_captures_ingest_uniq '
            . 'ON tpms_captures (device_sn, sensor_name, captured_at)'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS tpms_captures_ingest_uniq');
        Schema::dropIfExists('tpms_captures');
    }
};
