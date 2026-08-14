<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Locally-measured ride sessions + GPS trail.
 *
 * These are NOT the vendor's rides. `device_ride_history` comes from the
 * Ninebot cloud and inherits the vendor's SOC-curve-distorted energy figure;
 * these rows are measured on the vehicle itself by the relay phone:
 *
 *   - distance_m      GPS Doppler-integrated, not odometer deltas
 *   - max_speed_kph   median-filtered Doppler speed (a single bad fix can
 *                     otherwise invent a 90 km/h "top speed")
 *   - energy_wh       ∫V·I·dt from board frames — a real energy measurement
 *   - *_cycle_capacity_ah  board coulomb counter at both ends; the difference
 *                     is charge throughput in Ah, independent of any SOC curve
 *
 * The reconciler later matches each row against `device_ride_history` by
 * time overlap so the dashboard can show both figures side by side and
 * quantify how far the vendor estimate drifts. `match_status` stays
 * 'pending' until then; 'unmatched' is a legitimate terminal state (the
 * vendor cloud sometimes never records a short ride at all).
 *
 * clock_disciplined matters here more than anywhere else: with no SIM the
 * phone cannot reach NTP, so timestamps are only trustworthy once a GPS fix
 * has corrected the clock. Rows captured before the first fix are still
 * stored — their durations are valid (measured on the monotonic clock) even
 * though their absolute times may be off — but must not be time-matched
 * against vendor rides.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ride_sessions', function ($table): void {
            $table->id();
            $table->string('device_sn', 32);
            $table->string('source', 24)->default('relay_offline')
                ->comment('who measured this ride — relay_offline | future sources');

            $table->dateTime('started_at');
            $table->dateTime('ended_at');
            $table->integer('duration_seconds')->nullable();

            $table->float('distance_m')->default(0);
            $table->float('max_speed_kph')->nullable();
            $table->float('avg_speed_kph')->nullable();

            // Energy, measured three independent ways so they can cross-check.
            $table->float('energy_wh')->nullable()->comment('∫V·I·dt over board frames');
            $table->float('wh_per_km')->nullable()->comment('derived: energy_wh / (distance_m/1000)');
            $table->float('start_voltage_v')->nullable();
            $table->float('end_voltage_v')->nullable();
            $table->float('start_soc_pct')->nullable();
            $table->float('end_soc_pct')->nullable();
            $table->float('start_cycle_capacity_ah')->nullable();
            $table->float('end_cycle_capacity_ah')->nullable();
            $table->float('charge_throughput_ah')->nullable()
                ->comment('derived: end_cycle_capacity_ah − start_cycle_capacity_ah');

            $table->integer('sample_count')->default(0)
                ->comment('board frames folded into energy_wh — low counts mean a coarse integral');
            $table->integer('gps_point_count')->default(0);
            $table->boolean('clock_disciplined')->default(0);

            // Reconciliation against the vendor's own ride list.
            $table->string('match_status', 16)->default('pending')
                ->comment('pending | matched | unmatched');
            $table->string('matched_ride_id')->nullable()
                ->comment('device_ride_history.ride_id this overlaps in time');
            $table->float('vendor_mileage_km')->nullable();
            $table->float('vendor_energy_wh')->nullable();
            $table->dateTime('reconciled_at')->nullable();

            $table->json('payload')->nullable();
            $table->timestamps();

            $table->index(['device_sn', 'started_at']);
            $table->index(['match_status', 'started_at']);
        });

        // Idempotent ingestion: a re-flushed batch must not duplicate a ride.
        // The relay derives started_at from the first confirmed-moving sample,
        // which is deterministic for a given ride.
        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS ride_sessions_ingest_uniq '
            . 'ON ride_sessions (device_sn, started_at)'
        );

        Schema::create('ride_gps_points', function ($table): void {
            $table->id();
            // Nullable on purpose: points are flushed as they are recorded,
            // and the ride they belong to may not have closed (or may not
            // upload) until later. The stitcher fills this in afterwards.
            $table->unsignedBigInteger('ride_session_id')->nullable();
            $table->string('device_sn', 32);
            $table->dateTime('captured_at');

            $table->double('lat');
            $table->double('lon');
            $table->float('altitude_m')->nullable();
            $table->float('speed_mps')->nullable();
            $table->float('accuracy_m')->nullable();
            $table->float('bearing_deg')->nullable();
            $table->boolean('clock_disciplined')->default(0);
            $table->boolean('board_connected')->default(0)
                ->comment('false + movement = vehicle moved with the board detached');

            $table->timestamps();

            $table->index(['device_sn', 'captured_at']);
            $table->index(['ride_session_id', 'captured_at']);
        });

        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS ride_gps_points_ingest_uniq '
            . 'ON ride_gps_points (device_sn, captured_at)'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS ride_gps_points_ingest_uniq');
        DB::statement('DROP INDEX IF EXISTS ride_sessions_ingest_uniq');
        Schema::dropIfExists('ride_gps_points');
        Schema::dropIfExists('ride_sessions');
    }
};
