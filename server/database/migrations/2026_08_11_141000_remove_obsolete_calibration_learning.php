<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        foreach (['voltage_samples', 'consumption_samples', 'charge_cycles'] as $table) {
            Schema::dropIfExists($table);
        }
        DB::table('battery_calibration')->update([
            'soc_curve_params' => null,
            'is_calibrated' => false,
            'confidence_soc' => 0,
            'total_calibration_samples' => 0,
            'ec_recent_avg' => null,
            'ec_sample_count' => 0,
        ]);
    }

    public function down(): void
    {
        // Removed tables contained estimates derived from the retired model.
        // A rollback must restore code/schema from a database backup instead
        // of recreating empty tables that look trustworthy.
    }
};
