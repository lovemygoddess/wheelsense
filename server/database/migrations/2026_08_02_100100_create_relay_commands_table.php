<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * relay_commands — 服务端待下发给中继手机的远控指令队列。
 *
 * 与 bms_live_snapshots 方向相反：那张表是观测上行，这张是意图下行。
 * 中继无公网入口（尾箱、无 SIM、仅热点偶发联网），只能由它主动拉取，不能推送。
 * 因此这里存的是"意图 + 生命周期"，而非一次同步 RPC：
 *
 *  - status 是唯一状态机：pending → dispatched → done | failed | expired
 *  - dispatched_at 记录"已被某次轮询取走"，避免同一条指令被两次执行；
 *    超过 dispatch 超时仍未回执则可重新置回 pending（由 sweep 处理）。
 *  - expires_at 是必须的：拍照指令在两天后才被拉到毫无意义，甚至危险。
 *  - result / error 存执行回执，方便仪表盘显示"拍照失败：无相机权限"。
 *
 * 幂等：client_token 由下发方生成，唯一索引保证仪表盘重复点击不会排出两条指令。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('relay_commands', function ($table): void {
            $table->id();
            $table->string('device_sn', 32);

            // 指令本体
            $table->string('command', 32)
                ->comment('photo | shutdown | reboot — 白名单在 Controller 层');
            $table->json('payload')->nullable()
                ->comment('指令参数，如 photo 的 {camera:"back", quality:80}');

            // 生命周期
            $table->string('status', 16)->default('pending')
                ->comment('pending | dispatched | done | failed | expired');
            $table->unsignedTinyInteger('attempts')->default(0)
                ->comment('被轮询取走的次数 — 反复取走却无回执说明中继在指令上崩溃');
            $table->dateTime('dispatched_at')->nullable()->comment('被中继拉走的时刻');
            $table->dateTime('executed_at')->nullable()->comment('中继回传执行结果的时刻');
            $table->dateTime('expires_at')->nullable()->comment('过期后不再下发');

            // 回执
            $table->json('result')->nullable()->comment('中继回传的结构化结果（如照片 URL）');
            $table->string('error', 255)->nullable();

            // 来源与幂等
            $table->string('issued_by', 24)->default('dashboard')
                ->comment('dashboard | console | automation');
            $table->string('client_token', 64)->nullable()
                ->comment('下发方生成，用于重复提交去重');

            $table->timestamps();

            // 中继轮询的唯一查询形状：device_sn + status + created_at 排序
            $table->index(['device_sn', 'status', 'created_at']);
            $table->index(['status', 'expires_at']);
        });

        // 幂等下发：同一 client_token 只允许一条（NULL 不参与，SQLite 语义）
        DB::statement(
            'CREATE UNIQUE INDEX IF NOT EXISTS relay_commands_client_token_uniq '
            . 'ON relay_commands (client_token) WHERE client_token IS NOT NULL'
        );
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS relay_commands_client_token_uniq');
        Schema::dropIfExists('relay_commands');
    }
};
