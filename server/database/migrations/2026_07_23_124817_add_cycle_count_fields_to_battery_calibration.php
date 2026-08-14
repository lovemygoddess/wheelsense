<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('battery_calibration', function (Blueprint $table) {
            $table->integer('cycle_count_baseline')->nullable()->after('ec_validation_at');
            $table->float('cycle_count_baseline_wh', 10, 2)->nullable()->after('cycle_count_baseline');
        });
    }

    public function down(): void
    {
        Schema::table('battery_calibration', function (Blueprint $table) {
            $table->dropColumn(['cycle_count_baseline', 'cycle_count_baseline_wh']);
        });
    }
};
