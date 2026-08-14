<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_snapshots', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('device_id')->constrained()->cascadeOnDelete();
            $table->unsignedSmallInteger('gsm')->nullable();
            $table->unsignedBigInteger('gsm_time')->nullable();
            $table->unsignedTinyInteger('pwr')->nullable();
            $table->unsignedTinyInteger('dump_energy')->nullable();
            $table->decimal('bms_voltage', 8, 2)->nullable();
            $table->decimal('batt_temp', 6, 2)->nullable();
            $table->unsignedInteger('bms_cycles')->nullable();
            $table->unsignedTinyInteger('bms_score')->nullable();
            $table->decimal('charging_power', 10, 2)->nullable();
            $table->decimal('estimate_mileage', 10, 2)->nullable();
            $table->string('location_desc')->nullable();
            $table->decimal('latitude', 10, 7)->nullable();
            $table->decimal('longitude', 10, 7)->nullable();
            $table->unsignedTinyInteger('charging_state')->nullable();
            $table->unsignedTinyInteger('power_status')->nullable();
            $table->unsignedTinyInteger('lock_status')->nullable();
            $table->string('remain_charge_time')->nullable();
            $table->json('raw')->nullable();
            $table->timestamps();
            $table->index(['device_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_snapshots');
    }
};
