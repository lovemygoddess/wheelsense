<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Alert;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\DB;
use App\Models\BmsLiveSnapshot;
use App\Models\DeviceSnapshot;

/**
 * Aggregated health + recent logs for the whole stack. Previously the
 * sub-service statuses (ninecli / php / caddy / stream-proxy / scheduler),
 * the Laravel log tail, and the last DB backup were scattered across several
 * places with no single pane. This endpoint unifies them.
 */
class HealthController extends Controller
{
    private const SERVICES = [
        'ninebot-ninecli',
        'ninebot-php',
        'ninebot-scheduler',
        'ninebot-stream-proxy',
        'ninebot-caddy',
    ];

    public function index(): JsonResponse
    {
        $services = [];
        foreach (self::SERVICES as $svc) {
            $code = 0;
            $out = exec("systemctl is-active {$svc} 2>/dev/null", $_, $code);
            $services[$svc] = $code === 0 ? 'active' : 'inactive';
        }

        // Last DB backup timestamp (sqlite_backup.sh writes to storage/backups).
        $backupDir = storage_path('backups');
        $lastBackup = null;
        if (is_dir($backupDir)) {
            $files = glob($backupDir . '/db-*.sqlite');
            if ($files) {
                $last = max($files);
                $lastBackup = date('c', filemtime($last));
            }
        }

        // Tail of the Laravel log (last 50 lines).
        $logFile = storage_path('logs/laravel.log');
        $logTail = [];
        if (is_file($logFile)) {
            $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
            $logTail = array_slice($lines, -50);
        }

        return response()->json([
            'services'   => $services,
            'pipeline' => $this->pipelineHealth(),
            'last_backup' => $lastBackup,
            'log_tail'   => $logTail,
            'checked_at' => now()->toIso8601ZuluString(),
        ]);
    }

    /** @return array<string, mixed> */
    private function pipelineHealth(): array
    {
        $heartbeat = BmsLiveSnapshot::query()->live()->where('is_heartbeat', true)->latest('created_at')->first();
        $board = BmsLiveSnapshot::query()->live()->where('is_heartbeat', false)->where('crc_ok', true)->latest('captured_at')->first();
        $ninebot = DeviceSnapshot::query()->latest('created_at')->first();
        $age = static fn ($at): ?int => $at ? max(0, (int) $at->diffInSeconds(now())) : null;
        $dbPath = database_path('database.sqlite');
        return [
            'relay_heartbeat_age_seconds' => $age($heartbeat?->created_at),
            'board_frame_age_seconds' => $age($board?->captured_at),
            'ninecli_snapshot_age_seconds' => $age($ninebot?->created_at),
            'relay_pending_rows' => $heartbeat?->pending_rows !== null ? (int) $heartbeat->pending_rows : null,
            'queue_jobs' => DB::getSchemaBuilder()->hasTable('jobs') ? DB::table('jobs')->count() : 0,
            'failed_jobs' => DB::getSchemaBuilder()->hasTable('failed_jobs') ? DB::table('failed_jobs')->count() : 0,
            'database_bytes' => is_file($dbPath) ? filesize($dbPath) : null,
            'recent_critical_alerts' => Alert::query()->where('created_at', '>=', now()->subDay())->count(),
        ];
    }

    /**
     * Fire an alert. Always persists + logs it (A-31) — the previous build
     * silently dropped every alert when ALERT_WEBHOOK_URL was unset, so theft
     * / board-detach warnings never reached anyone. The webhook, if configured,
     * is a best-effort extra channel on top. Deduplicated per key for 15 min to
     * avoid alert storms.
     */
    public static function notify(string $key, string $message): void
    {
        $dedupe = "alert:{$key}";
        if (Cache::has($dedupe)) {
            return;
        }
        Cache::put($dedupe, true, now()->addMinutes(15));

        // Persist + log regardless of webhook configuration so alerts are never
        // swallowed. Wrapped so a storage failure can't break the request path.
        try {
            Alert::create([
                'key' => $key,
                'message' => $message,
                'level' => 'critical',
                'created_at' => now(),
            ]);
        } catch (\Throwable $e) {
            // Storage down must not abort the caller.
        }
        Log::critical("alert [{$key}]: {$message}");

        $url = (string) env('ALERT_WEBHOOK_URL', '');
        if ($url === '') {
            return;
        }
        try {
            Http::timeout(5)->post($url, [
                'title' => 'WheelSense',
                'message' => $message,
            ]);
        } catch (\Throwable $e) {
            // Never let alerting break the request path.
        }
    }

    public static function notifyRecovery(string $key, string $message): void
    {
        Cache::forget("alert:{$key}");
        try {
            Alert::create([
                'key' => "recovered:{$key}",
                'message' => $message,
                'level' => 'info',
                'created_at' => now(),
            ]);
        } catch (\Throwable) {
        }
        Log::info("recovery [{$key}]: {$message}");
    }
}
