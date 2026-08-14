<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Authoritative per-month ride aggregates from the upstream ninecli
 * `/vehicles/{sn}/travel?month=…` response (times / total_mileages / ec /
 * duration). The upstream `list[]` is capped at 20 rows per month, so
 * SUM(device_ride_history) only ever covers a fraction of real riding —
 * odometer/cycle-count math MUST be based on these aggregates instead.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_ride_month_summary', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('device_id')->constrained()->cascadeOnDelete();
            $table->string('month', 6);
            $table->unsignedInteger('ride_count')->default(0);
            $table->float('total_mileage_km')->default(0);
            $table->float('total_energy_wh')->default(0);
            $table->unsignedInteger('total_duration_sec')->default(0);
            $table->timestamps();

            $table->unique(['device_id', 'month']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_ride_month_summary');
    }
};
