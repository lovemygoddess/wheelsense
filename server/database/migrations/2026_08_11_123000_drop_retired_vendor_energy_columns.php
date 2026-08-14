<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        if (Schema::hasColumn('device_ride_history', 'used_electricity')) {
            Schema::table('device_ride_history', function (Blueprint $table): void {
                $table->dropColumn('used_electricity');
            });
        }
        if (Schema::hasColumn('device_ride_month_summary', 'total_energy_wh')) {
            Schema::table('device_ride_month_summary', function (Blueprint $table): void {
                $table->dropColumn('total_energy_wh');
            });
        }
    }

    public function down(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table): void {
            $table->float('used_electricity')->default(0);
        });
        Schema::table('device_ride_month_summary', function (Blueprint $table): void {
            $table->float('total_energy_wh')->default(0);
        });
    }
};
