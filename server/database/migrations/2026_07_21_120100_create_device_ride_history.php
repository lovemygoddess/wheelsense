<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_ride_history', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('device_id')->constrained()->cascadeOnDelete();
            $table->string('ride_id')->nullable();
            $table->string('month', 6)->index();
            $table->dateTime('started_at')->nullable();
            $table->dateTime('ended_at')->nullable();
            $table->decimal('mileage', 10, 2)->default(0);
            $table->decimal('energy', 10, 2)->default(0);
            $table->decimal('used_electricity', 10, 2)->default(0);
            $table->json('payload')->nullable();
            $table->timestamps();

            $table->unique(['device_id', 'ride_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_ride_history');
    }
};
