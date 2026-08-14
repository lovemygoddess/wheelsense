<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table): void {
            if (! Schema::hasColumn('bms_live_snapshots', 'battery_status')) $table->unsignedTinyInteger('battery_status')->nullable();
            if (! Schema::hasColumn('bms_live_snapshots', 'charge_mosfet_code')) $table->unsignedTinyInteger('charge_mosfet_code')->nullable();
            if (! Schema::hasColumn('bms_live_snapshots', 'discharge_mosfet_code')) $table->unsignedTinyInteger('discharge_mosfet_code')->nullable();
            if (! Schema::hasColumn('bms_live_snapshots', 'balancer_code')) $table->unsignedTinyInteger('balancer_code')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function (Blueprint $table): void {
            foreach (['battery_status', 'charge_mosfet_code', 'discharge_mosfet_code', 'balancer_code'] as $column) {
                if (Schema::hasColumn('bms_live_snapshots', $column)) $table->dropColumn($column);
            }
        });
    }
};
