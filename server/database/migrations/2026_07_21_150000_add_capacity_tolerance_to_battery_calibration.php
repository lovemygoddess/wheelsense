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
            if (! in_array('capacity_tolerance_pct', $columns, true)) {
                $table->decimal('capacity_tolerance_pct', 5, 2)->nullable()->default(20.0);
            }
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));
        if (in_array('capacity_tolerance_pct', $columns, true)) {
            try { DB::statement('ALTER TABLE battery_calibration DROP COLUMN capacity_tolerance_pct'); } catch (\Throwable) {}
        }
    }
};
