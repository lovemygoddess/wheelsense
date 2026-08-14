<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $existing = array_map(fn ($t) => $t->name, DB::select("SELECT name FROM sqlite_master WHERE type='table'"));

        // 1. 检测到的充电会话（开/闭/满电）
        if (! in_array('charge_events', $existing, true)) {
            Schema::create('charge_events', function (Blueprint $table): void {
                $table->id();
                $table->string('device_sn')->index();
                $table->dateTime('started_at');
                $table->dateTime('ended_at')->nullable();
                $table->decimal('start_voltage', 8, 2)->nullable();
                $table->decimal('end_voltage', 8, 2)->nullable();
                $table->decimal('avg_temp', 6, 2)->nullable();
                $table->decimal('peak_voltage', 8, 2)->nullable();
                $table->boolean('is_full_charge')->default(false);
                $table->string('detection_method')->nullable();
                $table->timestamps();

                $table->index(['device_sn', 'ended_at']);
                $table->index(['device_sn', 'is_full_charge', 'started_at']);
            });
        }

        // 2. 闭合的充放电周期
        if (! in_array('charge_cycles', $existing, true)) {
            Schema::create('charge_cycles', function (Blueprint $table): void {
                $table->id();
                $table->string('device_sn')->index();
                $table->unsignedBigInteger('start_charge_event_id')->nullable();
                $table->unsignedBigInteger('end_charge_event_id')->nullable();
                $table->decimal('total_mileage_km', 10, 2);
                $table->dateTime('start_at');
                $table->dateTime('end_at');
                $table->decimal('avg_temp', 6, 2)->nullable();
                $table->string('temp_bucket', 16)->nullable();
                $table->unsignedInteger('sample_count')->default(0);
                $table->decimal('confidence', 5, 4)->default(0);
                $table->timestamps();
            });
        }

        // 3. 电压 -> implied SOC 训练样本
        if (! in_array('voltage_samples', $existing, true)) {
            Schema::create('voltage_samples', function (Blueprint $table): void {
                $table->id();
                $table->string('device_sn')->index();
                $table->dateTime('recorded_at');
                $table->decimal('voltage', 8, 3);
                $table->decimal('implied_soc', 6, 5);
                $table->decimal('temperature', 6, 2)->nullable();
                $table->string('temp_bucket', 16)->index();
                $table->unsignedBigInteger('cycle_id')->nullable();
                $table->string('source', 32)->default('auto');
                $table->timestamps();

                $table->index(['device_sn', 'temp_bucket', 'voltage']);
            });
        }

        // 4. 能耗训练样本
        if (! in_array('consumption_samples', $existing, true)) {
            Schema::create('consumption_samples', function (Blueprint $table): void {
                $table->id();
                $table->string('device_sn')->index();
                $table->string('ride_id')->nullable();
                $table->dateTime('recorded_at');
                $table->decimal('mileage_km', 10, 3);
                $table->decimal('voltage_before', 8, 3);
                $table->decimal('voltage_after', 8, 3);
                $table->decimal('delta_soc', 6, 5);
                $table->decimal('energy_wh_estimated', 10, 3);
                $table->decimal('wh_per_km_ride', 10, 4);
                $table->decimal('temperature', 6, 2)->nullable();
                $table->string('temp_bucket', 16)->index();
                $table->decimal('weight', 6, 3)->default(1.0);
                $table->string('source', 32)->default('auto');
                $table->timestamps();

                $table->index(['device_sn', 'recorded_at']);
            });
        }

        // 5. 当前校准参数
        if (! in_array('battery_calibration', $existing, true)) {
            Schema::create('battery_calibration', function (Blueprint $table): void {
                $table->id();
                $table->string('device_sn')->unique();
                $table->decimal('capacity_wh_estimate', 10, 2)->nullable();
                $table->decimal('wh_per_km_current', 10, 4)->nullable();
                $table->decimal('wh_per_km_slope', 10, 6)->default(0);
                $table->json('soc_curve_params')->nullable();
                $table->unsignedInteger('soc_curve_version')->default(0);
                $table->unsignedInteger('total_calibration_samples')->default(0);
                $table->decimal('confidence_soc', 5, 4)->default(0);
                $table->decimal('confidence_consumption', 5, 4)->default(0);
                $table->dateTime('last_calibrated_at')->nullable();
                $table->boolean('is_calibrated')->default(false);
                $table->timestamps();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('battery_calibration');
        Schema::dropIfExists('consumption_samples');
        Schema::dropIfExists('voltage_samples');
        Schema::dropIfExists('charge_cycles');
        Schema::dropIfExists('charge_events');
    }
};
