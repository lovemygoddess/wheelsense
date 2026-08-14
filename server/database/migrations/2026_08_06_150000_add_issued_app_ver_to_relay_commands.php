<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 给远控指令加 issued_app_ver：下发 update_apk 时记下当时中继的 app_ver，
 * 用于心跳对账——当中继回报的 app_ver 比它大，说明更新已落地，把卡在
 * pending/dispatched 的 update_apk 自动结案（root 静默安装时进程可能在回报
 * HTTP 前就被替换，导致命令永远停在「执行中」）。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('relay_commands', function (Blueprint $table) {
            $table->string('issued_app_ver', 32)->nullable()->after('issued_by')
                ->comment('下发时中继的 app_ver，用于对账自动结案');
        });
    }

    public function down(): void
    {
        Schema::table('relay_commands', function (Blueprint $table) {
            $table->dropColumn('issued_app_ver');
        });
    }
};
