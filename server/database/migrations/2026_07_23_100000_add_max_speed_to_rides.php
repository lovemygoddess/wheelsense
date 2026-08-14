<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Add per-ride max-speed storage and a device-level lifetime peak.
 *
 * Background: `/vehicles/{sn}/travel/{travel_id}` returns a `trail` field
 * with 200-430 GPS samples per ride, each carrying an instantaneous
 * speed in the 4th column. The peak positive value is the "本次极速"
 * the user wants to display. (A reference device whose vendor app shows
 * "最高速度 79 km/h" is almost certainly reading this same field.)
 *
 * We persist the peak per ride (1 row per ride → 1 max-speed value) so
 * the dashboard can show "本次 XX km/h" without re-fetching from
 * upstream every time.
 *
 * Computation: see app/Console/Commands/BackfillRideMaxSpeedCommand.php —
 * it walks the trail string, filters out the rare negative signed-kinematic
 * values, and writes max(positive) here.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table): void {
            // max speed in km/h for this ride, derived from `trail` 4th column
            // (max of positive values). null = not yet backfilled.
            $table->decimal('max_speed_kph', 5, 2)->nullable()->after('energy');
            $table->index('max_speed_kph');
        });
    }

    public function down(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table): void {
            $table->dropIndex(['max_speed_kph']);
            $table->dropColumn('max_speed_kph');
        });
    }
};
