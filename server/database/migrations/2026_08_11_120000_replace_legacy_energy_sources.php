<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table): void {
            if (! Schema::hasColumn('device_ride_history', 'energy_source')) {
                $table->string('energy_source', 32)->nullable();
            }
            if (! Schema::hasColumn('device_ride_history', 'energy_coverage')) {
                $table->float('energy_coverage')->nullable();
            }
            if (! Schema::hasColumn('device_ride_history', 'wh_per_km')) {
                $table->float('wh_per_km')->nullable();
            }
        });

        DB::table('device_ride_history')->update([
            'energy' => 0,
            'energy_source' => null,
            'energy_coverage' => null,
            'wh_per_km' => null,
        ]);

        DB::table('device_ride_history')->orderBy('id')->chunkById(200, function ($rows): void {
            foreach ($rows as $row) {
                $payload = json_decode((string) ($row->payload ?? ''), true);
                if (! is_array($payload)) {
                    continue;
                }
                foreach (['energy', 'ec', 'used_electricity', 'electricity'] as $key) {
                    unset($payload[$key]);
                }
                DB::table('device_ride_history')->where('id', $row->id)->update([
                    'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                ]);
            }
        });

        foreach (DB::table('battery_calibration')->get(['id', 'device_sn']) as $cal) {
            $measuredWh = (float) DB::table('bms_energy_intervals')
                ->where('device_sn', $cal->device_sn)
                ->sum('energy_wh');
            DB::table('battery_calibration')->where('id', $cal->id)->update([
                'cycle_count_baseline_wh' => round($measuredWh, 3),
                'ec_recent_avg' => null,
                'ec_sample_count' => 0,
                'ec_deviation_pct' => null,
                'ec_validation_status' => null,
                'ec_validation_at' => null,
            ]);
        }

        Schema::table('consumption_samples', function (Blueprint $table): void {
            $drop = array_values(array_filter(
                ['ec_wh_per_km', 'wh_per_km_coulomb'],
                fn (string $column): bool => Schema::hasColumn('consumption_samples', $column),
            ));
            if ($drop !== []) {
                $table->dropColumn($drop);
            }
        });
    }

    public function down(): void
    {
        Schema::table('consumption_samples', function (Blueprint $table): void {
            if (! Schema::hasColumn('consumption_samples', 'ec_wh_per_km')) {
                $table->float('ec_wh_per_km')->nullable();
            }
            if (! Schema::hasColumn('consumption_samples', 'wh_per_km_coulomb')) {
                $table->float('wh_per_km_coulomb')->nullable();
            }
        });

        Schema::table('device_ride_history', function (Blueprint $table): void {
            $drop = array_values(array_filter(
                ['energy_source', 'energy_coverage', 'wh_per_km'],
                fn (string $column): bool => Schema::hasColumn('device_ride_history', $column),
            ));
            if ($drop !== []) {
                $table->dropColumn($drop);
            }
        });
    }
};
