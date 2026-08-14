<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * 给 tpms_captures 增加 mac 列。
 *
 * v31 relay 起，抓包按 MAC 区分物理设备（前后轮 TPMS 可能共用 BLE 名
 * "JH.TPMS"），并在每条记录里带上原始 MAC，便于离线解码时按物理设备聚合，
 * 后续落结构化字段时也用它做前后轮绑定。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasColumn('tpms_captures', 'mac')) {
            Schema::table('tpms_captures', function ($table): void {
                $table->string('mac', 17)->nullable()->after('sensor_name')
                    ->comment('传感器原始 MAC，区分共用 BLE 名的前后轮');
            });
            DB::statement(
                'CREATE INDEX IF NOT EXISTS tpms_captures_mac_idx '
                . 'ON tpms_captures (mac)'
            );
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('tpms_captures', 'mac')) {
            DB::statement('DROP INDEX IF EXISTS tpms_captures_mac_idx');
            Schema::table('tpms_captures', function ($table): void {
                $table->dropColumn('mac');
            });
        }
    }
};
