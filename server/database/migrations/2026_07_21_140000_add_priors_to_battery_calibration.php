<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        // Idempotent column adds.
        Schema::table('battery_calibration', function (Blueprint $table) use (&$columns): void {
            if (! in_array('chemistry_type', $columns, true))            $table->string('chemistry_type', 32)->nullable();
            if (! in_array('cell_series_count', $columns, true))        $table->unsignedSmallInteger('cell_series_count')->nullable();
            if (! in_array('bms_full_charge_voltage', $columns, true))  $table->decimal('bms_full_charge_voltage', 8, 3)->nullable();
            if (! in_array('bms_cutoff_voltage', $columns, true))       $table->decimal('bms_cutoff_voltage', 8, 3)->nullable();
            if (! in_array('max_charge_current_a', $columns, true))     $table->decimal('max_charge_current_a', 6, 2)->nullable();
            if (! in_array('nominal_voltage', $columns, true))          $table->decimal('nominal_voltage', 6, 2)->nullable();
            if (! in_array('nominal_capacity_ah', $columns, true))      $table->decimal('nominal_capacity_ah', 6, 2)->nullable();
            if (! in_array('priors_updated_at', $columns, true))        $table->timestamp('priors_updated_at')->nullable();
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        foreach (['priors_updated_at', 'nominal_capacity_ah', 'nominal_voltage', 'max_charge_current_a', 'bms_cutoff_voltage', 'bms_full_charge_voltage', 'cell_series_count', 'chemistry_type'] as $col) {
            if (in_array($col, $columns, true)) {
                try { DB::statement("ALTER TABLE battery_calibration DROP COLUMN $col"); } catch (\Throwable) {}
            }
        }
    }
};
