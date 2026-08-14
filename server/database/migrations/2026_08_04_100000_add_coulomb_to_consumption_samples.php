<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * B 档计量：消费样本新增 `wh_per_km_coulomb`。
 * 由 CoulombRideEnergyEstimator 用保护板真实电流时间序列 ∫V×I dt 推算，
 * 优先级高于电压法/ec。无电流序列时留 NULL（学习器自动降级）。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('consumption_samples', 'wh_per_km_coulomb')) {
            Schema::table('consumption_samples', function (Blueprint $table): void {
                $table->float('wh_per_km_coulomb')->nullable();
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('consumption_samples', 'wh_per_km_coulomb')) {
            Schema::table('consumption_samples', function (Blueprint $table): void {
                $table->dropColumn('wh_per_km_coulomb');
            });
        }
    }
};
