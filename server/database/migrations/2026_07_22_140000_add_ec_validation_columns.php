<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // 1. consumption_samples: store the real per-ride ec_wh_per_km so we can
        //    build the rolling average comparison separately from SOC-based Wh/km.
        Schema::table('consumption_samples', function (Blueprint $table): void {
            $table->decimal('ec_wh_per_km', 10, 4)->nullable()->after('wh_per_km_ride');
        });

        // 2. battery_calibration: cache the latest ec validation summary so the
        //    UI can read it without recomputing on every request.
        Schema::table('battery_calibration', function (Blueprint $table): void {
            $table->decimal('ec_recent_avg', 10, 4)->nullable()->after('wh_per_km_current');
            $table->unsignedInteger('ec_sample_count')->default(0)->after('ec_recent_avg');
            $table->decimal('ec_deviation_pct', 6, 2)->nullable()->after('ec_sample_count');
            $table->string('ec_validation_status', 16)->nullable()->after('ec_deviation_pct');
            $table->dateTime('ec_validation_at')->nullable()->after('ec_validation_status');
        });
    }

    public function down(): void
    {
        Schema::table('battery_calibration', function (Blueprint $table): void {
            $table->dropColumn(['ec_recent_avg', 'ec_sample_count', 'ec_deviation_pct', 'ec_validation_status', 'ec_validation_at']);
        });
        Schema::table('consumption_samples', function (Blueprint $table): void {
            $table->dropColumn('ec_wh_per_km');
        });
    }
};
