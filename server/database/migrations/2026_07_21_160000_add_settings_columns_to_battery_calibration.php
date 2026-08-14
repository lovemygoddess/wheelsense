<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        Schema::table('battery_calibration', function ($table) use (&$columns): void {
            // Temperature bucket boundaries
            if (! in_array('temp_bucket_cold_max_c', $columns, true)) {
                $table->decimal('temp_bucket_cold_max_c', 5, 2)->nullable()->default(5.0);
            }
            if (! in_array('temp_bucket_warm_max_c', $columns, true)) {
                $table->decimal('temp_bucket_warm_max_c', 5, 2)->nullable()->default(20.0);
            }
            // Algorithm thresholds (Plan B subset)
            if (! in_array('plateau_voltage_delta', $columns, true)) {
                $table->decimal('plateau_voltage_delta', 4, 2)->nullable()->default(0.30);
            }
            if (! in_array('plateau_min_minutes', $columns, true)) {
                $table->unsignedSmallInteger('plateau_min_minutes')->nullable()->default(15);
            }
            if (! in_array('capacity_ema_alpha_base', $columns, true)) {
                $table->decimal('capacity_ema_alpha_base', 4, 3)->nullable()->default(0.050);
            }
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));
        foreach (['capacity_ema_alpha_base', 'plateau_min_minutes', 'plateau_voltage_delta', 'temp_bucket_warm_max_c', 'temp_bucket_cold_max_c'] as $col) {
            if (in_array($col, $columns, true)) {
                try { DB::statement("ALTER TABLE battery_calibration DROP COLUMN $col"); } catch (\Throwable) {}
            }
        }
    }
};