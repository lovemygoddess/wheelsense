<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Adds ant_bms_measured_current_a — the charge current the user reads off
 * the Ant BMS app during a charge session (constant-current phase).
 *
 * Why current, not power: pack voltage rises throughout a charge, so a
 * one-shot *power* reading goes stale as the estimate (V × I) drifts away
 * from it. Current is flat during the whole CC phase, making it a stable
 * comparison anchor for charger_output_current_a.
 */
return new class extends Migration
{
    public function up(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        Schema::table('battery_calibration', function (Blueprint $table) use (&$columns): void {
            if (! in_array('ant_bms_measured_current_a', $columns, true)) {
                $table->decimal('ant_bms_measured_current_a', 6, 2)->nullable()->after('ant_bms_displayed_power_w');
            }
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));
        if (in_array('ant_bms_measured_current_a', $columns, true)) {
            try { DB::statement("ALTER TABLE battery_calibration DROP COLUMN ant_bms_measured_current_a"); } catch (\Throwable) {}
        }
    }
};
