<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Adds two user-tunable priors for charger power estimation:
 *
 *   charger_output_current_a     — the configured charger's actual output
 *                                  current (amps). When set, this supersedes
 *                                  max_charge_current_a in the charge-power
 *                                  formula (V × I) because the charger's real
 *                                  output is far more accurate than the BMS
 *                                  spec max for a *reporting* wattage.
 *
 *   ant_bms_displayed_power_w    — a one-shot reading the user copies off the
 *                                  Ant BMS protection board display during a
 *                                  charge session. The system compares it
 *                                  against the estimated charge_power_w to
 *                                  surface a deviation %, so the user can
 *                                  dial in charger_output_current_a until
 *                                  the estimate matches reality.
 */
return new class extends Migration
{
    public function up(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        Schema::table('battery_calibration', function (Blueprint $table) use (&$columns): void {
            if (! in_array('charger_output_current_a', $columns, true)) {
                $table->decimal('charger_output_current_a', 6, 2)->nullable()->after('max_charge_current_a');
            }
            if (! in_array('ant_bms_displayed_power_w', $columns, true)) {
                $table->decimal('ant_bms_displayed_power_w', 8, 2)->nullable()->after('charger_output_current_a');
            }
        });
    }

    public function down(): void
    {
        $columns = array_map(fn ($c) => $c->name, DB::select("PRAGMA table_info(battery_calibration)"));

        foreach (['ant_bms_displayed_power_w', 'charger_output_current_a'] as $col) {
            if (in_array($col, $columns, true)) {
                try { DB::statement("ALTER TABLE battery_calibration DROP COLUMN $col"); } catch (\Throwable) {}
            }
        }
    }
};
