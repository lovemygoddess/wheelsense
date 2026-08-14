<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

/**
 * Composite index for the relayLiveBms hot lookup.
 *
 * DashboardController::relayLiveBms filters
 *   WHERE device_sn = ? AND source = 'relay' AND crc_ok = 1
 *   ORDER BY created_at DESC LIMIT 1
 *
 * The table grows unboundedly once the relay runs continuously (~2.1 s/frame
 * while riding ⇒ tens of thousands of rows/day). The existing
 * (device_sn, source) index narrows to one device's relay rows but still has
 * to sort them by created_at; appending created_at to the index lets SQLite
 * walk it in order and stop at the first match instead of sorting.
 *
 * Left as an ADDITIONAL index (not replacing (device_sn, source)) so nothing
 * already depending on the narrower index changes behaviour.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->index(['device_sn', 'source', 'created_at'], 'bms_live_relay_lookup_index');
        });
    }

    public function down(): void
    {
        Schema::table('bms_live_snapshots', function ($table): void {
            $table->dropIndex('bms_live_relay_lookup_index');
        });
    }
};
