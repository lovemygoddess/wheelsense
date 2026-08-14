<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * bms_live_snapshots — episodic high-precision BMS samples captured while
 * a paired phone is physically within BLE range of the vehicle and the
 * BMS monitor page is open. NOT a continuous data source.
 *
 * Relationship to device_snapshots: orthogonal. device_snapshots is a 5-min
 * continuous stream from the Ninebot cloud API. bms_live_snapshots is a
 * sparse, human-triggered direct-BLE read used for cross-verification.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('bms_live_snapshots', function (Blueprint $table): void {
            $table->id();
            $table->string('device_sn', 32);

            // BMS raw fields (parsed, not re-derived)
            $table->unsignedTinyInteger('cell_count')->nullable();
            $table->json('cells_mv')->nullable();
            $table->decimal('total_voltage_v', 6, 3)->nullable();
            $table->decimal('current_a', 7, 3)->nullable();
            $table->decimal('soc_pct', 5, 1)->nullable();
            $table->decimal('soh_pct', 5, 1)->nullable();
            $table->decimal('capacity_total_ah', 7, 3)->nullable();
            $table->decimal('capacity_remaining_ah', 7, 3)->nullable();
            $table->decimal('power_w', 8, 2)->nullable();
            $table->json('temps_c')->nullable();
            $table->unsignedInteger('runtime_seconds')->nullable();

            // Quality markers
            $table->boolean('crc_ok')->default(false);
            $table->text('frame_hex')->nullable();
            $table->string('parse_error', 255)->nullable();

            // Cross-verification (filled by backend, nullable until then)
            $table->decimal('ninebot_voltage_v', 6, 3)->nullable();
            $table->decimal('ninebot_soc_pct', 5, 1)->nullable();
            $table->decimal('voltage_diff_v', 5, 3)->nullable();
            $table->decimal('soc_diff_pct', 5, 1)->nullable();

            $table->timestamp('captured_at')->nullable();
            $table->timestamps();

            $table->index(['device_sn', 'captured_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bms_live_snapshots');
    }
};
