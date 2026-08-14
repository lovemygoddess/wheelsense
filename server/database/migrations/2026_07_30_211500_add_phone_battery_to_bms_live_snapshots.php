<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Adds the relay PHONE's own battery health alongside the BMS board telemetry,
 * so a dead/overheating phone relay is visible in the same snapshot row.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table): void {
            $table->decimal('phone_battery_level_pct', 5, 1)->nullable()->comment('relay phone battery level %');
            $table->decimal('phone_battery_temp_c', 5, 2)->nullable()->comment('relay phone battery temperature °C');
            $table->boolean('phone_charging')->nullable()->comment('relay phone plugged in?');
            $table->decimal('phone_battery_voltage_v', 6, 3)->nullable()->comment('relay phone battery voltage V');
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table): void {
            $table->dropColumn([
                'phone_battery_level_pct',
                'phone_battery_temp_c',
                'phone_charging',
                'phone_battery_voltage_v',
            ]);
        });
    }
};
