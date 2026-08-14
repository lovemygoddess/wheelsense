<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('ride_gps_points');
        Schema::dropIfExists('ride_sessions');
    }

    public function down(): void
    {
        // The discontinued relay ride recorder has no supported rollback path.
    }
};
