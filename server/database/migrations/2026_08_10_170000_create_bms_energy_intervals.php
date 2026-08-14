<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('bms_energy_intervals', function (Blueprint $table): void {
            $table->id();
            $table->string('device_sn', 64)->index();
            $table->dateTime('started_at');
            $table->dateTime('ended_at');
            $table->float('energy_wh');
            $table->unsignedInteger('duration_seconds');
            $table->float('start_power_w')->nullable();
            $table->float('end_power_w')->nullable();
            $table->timestamps();
            $table->unique(['device_sn', 'started_at', 'ended_at'], 'bms_energy_interval_unique');
            $table->index(['device_sn', 'ended_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bms_energy_intervals');
    }
};
