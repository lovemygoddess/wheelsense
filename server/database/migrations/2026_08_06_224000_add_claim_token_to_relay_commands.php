<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 给远控指令加 claim_token：poll 改为「条件 UPDATE 原子领取 + 按 token 回读」。
 *
 * 原实现是 SELECT 出待办再逐行 save()，两步之间没有任何互斥。poll_ms 默认
 * 3 秒，网络抖动重发或新旧进程重叠时，两次 poll 会读到同一批 pending 并各自
 * 派发一次——同一条 reboot/shell 被执行两遍，attempts 还会因读-改-写而丢更新。
 * APK 侧虽有本地去重表，但重启即清空，防线并不可靠。
 *
 * SQLite 的单条 UPDATE 语句本身是原子的，因此改为：先用一条带 LIMIT 子查询的
 * UPDATE 抢占并打上本次调用独有的 claim_token，再按该 token 回读。两个并发
 * poll 只有一个能改到行，另一个 affected=0，天然互斥。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('relay_commands', function (Blueprint $table) {
            $table->string('claim_token', 64)->nullable()->after('client_token')
                ->comment('poll 原子领取时写入，用于回读本次抢到的命令');
        });

        // 回读走 (claim_token) 等值查询；nullable 列上普通索引即可。
        Schema::table('relay_commands', function (Blueprint $table) {
            $table->index('claim_token', 'relay_commands_claim_token_index');
        });
    }

    public function down(): void
    {
        Schema::table('relay_commands', function (Blueprint $table) {
            $table->dropIndex('relay_commands_claim_token_index');
            $table->dropColumn('claim_token');
        });
    }
};
