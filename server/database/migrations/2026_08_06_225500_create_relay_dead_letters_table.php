<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 中继回传被拒条目的死信表。
 *
 * /api/relay/batch 有个刻意的设计：被拒条目照样推进 last_seq，避免一条坏数据
 * 把整条离线队列永久卡死（见控制器头部的 "No poison pills"）。这个取舍本身是
 * 对的，但代价是——中继收到 ack 后就把那些行从本地 outbox 删了，服务端又没
 * 存，数据就此人间蒸发，而且 parseInstant() 判空那条路径连日志都不打。
 *
 * 真正危险的不是偶发坏帧，是系统性失败：尾箱手机无网冷启动时 RTC 可能整个
 * 跑飞，captured_at 落到年份范围外 → 整批全拒 → 几天的积压一次性静默销毁，
 * 事后连"丢了什么、为什么丢"都查不到。
 *
 * 这张表就是那个黑盒记录仪：拒了什么、什么原因、原始 payload 长什么样。
 * 它是诊断用途，不是数据仓库，因此有条数上限 + 按天清理，写失败也绝不允许
 * 反过来阻断主回传链路。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('relay_dead_letters', function (Blueprint $table) {
            $table->id();
            $table->string('device_sn', 32);
            // 中继 outbox 的行号。配合 device_sn 可以和手机侧日志对上。
            $table->unsignedBigInteger('seq')->default(0);
            $table->string('kind', 16)->nullable();
            // 机器可读的短原因：bad_timestamp / implausible_frame / ...
            $table->string('reason', 48);
            // 原始 payload 的 JSON，超长会被截断（诊断够用即可）。
            $table->text('payload')->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index(['device_sn', 'created_at'], 'relay_dead_letters_sn_created_index');
            $table->index('reason', 'relay_dead_letters_reason_index');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('relay_dead_letters');
    }
};
