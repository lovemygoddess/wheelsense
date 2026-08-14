<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Adds an odometer baseline for the "total mileage" display:
 *
 *   odometer_baseline_km       — the ODO reading the user copies off the
 *                                Ninebot app / dash (km). Upstream
 *                                /vehicles total_mileage is always null, so
 *                                this is the only ground truth available.
 *
 *   odometer_baseline_ride_km  — snapshot of SUM(device_ride_history.mileage)
 *                                at the moment the baseline was set. Displayed
 *                                total = baseline_km + (current_sum - baseline_ride_km).
 *
 * Mirrors the existing cycle_count_baseline / cycle_count_baseline_wh pair.
 */
return new class extends Migration
{
    public function up(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        Schema::table('battery_calibration', function (Blueprint $table) use (&$columns): void {
            if (! in_array('odometer_baseline_km', $columns, true)) {
                $table->decimal('odometer_baseline_km', 10, 1)->nullable();
            }
            if (! in_array('odometer_baseline_ride_km', $columns, true)) {
                $table->decimal('odometer_baseline_ride_km', 10, 1)->nullable();
            }
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        foreach (['odometer_baseline_km', 'odometer_baseline_ride_km'] as $col) {
            if (in_array($col, $columns, true)) {
                try { DB::statement("ALTER TABLE battery_calibration DROP COLUMN $col"); } catch (\Throwable) {}
            }
        }
    }
};
