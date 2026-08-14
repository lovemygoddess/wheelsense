<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Daily retention for the ever-growing telemetry tables.
 *
 * Until now nothing ever deleted rows: bms_live_snapshots / env_samples /
 * TPMS captures grew without bound and the database was only reclaimed by
 * manual intervention. This command is wired into the
 * schedule-loop once per day.
 *
 * Deliberately NOT pruned:
 *  - the rolling heartbeat row (is_heartbeat = 1) — it IS the liveness signal;
 *  - consumption_samples — the self-learning wh/km estimate trains on it;
 *  - device_ride_history — compact NineCLI summaries used by the ride page.
 */
class PruneHistoryCommand extends Command
{
    protected $signature = 'evtelemetry:prune-history {--days=30 : retention window in days}';
    protected $description = 'Delete telemetry rows older than the retention window (daily task)';

    /** Rows per DELETE so one pass never holds a long write lock on SQLite. */
    private const CHUNK = 5000;

    public function handle(): int
    {
        $days = max(1, (int) $this->option('days'));
        $cutoff = now()->subDays($days)->format('Y-m-d H:i:s');
        $this->info("prune-history: cutoff {$cutoff} ({$days}d)");

        $total = 0;
        $total += $this->prune('bms_live_snapshots', 'captured_at', $cutoff, 'is_heartbeat = 0');
        $total += $this->prune('env_samples', 'captured_at', $cutoff);
        // Closed command rows are audit noise after a month. 'expired' is a
        // terminal state too (written by evtelemetry:sweep-commands) — leaving it
        // out would let stalled rows accumulate forever, which is exactly the
        // unbounded growth this prune exists to prevent.
        $total += $this->prune('relay_commands', 'created_at', $cutoff, "status IN ('done','failed','expired')");
        // Dead letters already have a ring cap in the ingest path; this is just
        // the age backstop so a long-quiet table doesn't hold month-old noise.
        $total += $this->prune('relay_dead_letters', 'created_at', $cutoff);
        // tpms_captures 是调试/解码落点，relay 持续写入；不清理会无限膨胀
        // （survey 模式曾一次灌入上万行无关设备）。传感器每 ~10 分钟重播，保留窗口
        // 内必有新帧，故按相同留存窗口清理即可，不影响仪表盘取最新读数。
        $total += $this->prune('tpms_captures', 'captured_at', $cutoff);

        $this->info("prune-history: deleted {$total} rows total");
        return self::SUCCESS;
    }

    private function prune(string $table, string $column, string $cutoff, ?string $extraWhere = null): int
    {
        $deleted = 0;
        do {
            $where = "{$column} < ?";
            $bindings = [$cutoff];
            if ($extraWhere !== null) {
                $where .= " AND {$extraWhere}";
            }
            // id-bounded subquery keeps every chunk cheap on an unindexed scan.
            $n = DB::delete(
                "DELETE FROM {$table} WHERE id IN (SELECT id FROM {$table} WHERE {$where} LIMIT " . self::CHUNK . ')',
                $bindings,
            );
            $deleted += $n;
        } while ($n === self::CHUNK);

        if ($deleted > 0) {
            $this->info("  {$table}: -{$deleted}");
        }
        return $deleted;
    }
}
