<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table) {
            $table->string('speed_analysis_status', 20)->default('pending')->after('max_speed_kph');
            $table->timestamp('analyzed_at')->nullable()->after('speed_analysis_status');
            $table->index('speed_analysis_status');
        });
    }

    public function down(): void
    {
        Schema::table('device_ride_history', function (Blueprint $table) {
            $table->dropColumn(['speed_analysis_status', 'analyzed_at']);
        });
    }
};
