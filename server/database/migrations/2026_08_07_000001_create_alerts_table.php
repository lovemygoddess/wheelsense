<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Durable alert log so HealthController::notify() can persist alerts even
     * without an external webhook (A-31). Previously those alerts were dropped.
     */
    public function up(): void
    {
        Schema::create('alerts', function (Blueprint $table): void {
            $table->id();
            $table->string('key', 120);
            $table->text('message');
            $table->string('level', 16)->default('critical');
            $table->timestamp('created_at')->nullable();

            $table->index('key');
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('alerts');
    }
};
