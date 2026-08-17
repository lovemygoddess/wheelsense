<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\BmsLiveSnapshot;
use App\Models\RelayCommand;
use App\Support\ApiResponder;
use App\Support\BmsSanity;
use App\Support\EnvSanity;
use App\Support\RelayAuth;
use App\ValueObjects\Api\ErrorObject;
use App\Services\Rides\BmsEnergyIntervalService;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * POST /api/relay/batch — bulk ingestion for the SIM-less relay phone.
 *
 * The relay lives in the scooter's tail box with no mobile data. It records
 * continuously into a local SQLite outbox and flushes the backlog whenever the
 * owner's hotspot happens to come into range, which may be minutes or days
 * later. Three properties follow from that and drive this whole class:
 *
 *  1. **Acknowledged deletion.** The phone only deletes rows the server has
 *     confirmed by sequence. So `last_seq` is a promise: everything up to and
 *     including it is durably stored. A 2xx response therefore MUST always
 *     carry a `last_seq`; returning 200 without one makes the client fall back
 *     to "assume the whole batch landed" and silently drop unsent data. When
 *     nothing could be processed we deliberately return 5xx instead.
 *
 *  2. **No poison pills.** A single malformed row must never wedge the queue
 *     forever. Bad rows are counted and skipped while `last_seq` still
 *     advances past them; only a genuine server-side fault stops the drain.
 *     The flip side is that a skipped row is about to be deleted from the
 *     phone, so it is copied into `relay_dead_letters` on the way out —
 *     otherwise a drifting RTC could silently destroy an entire backlog with
 *     nothing left to explain what went missing.
 *
 *  3. **Backfill is not liveness.** Rows arriving in a flush are written with
 *     created_at = now() but describe the past. `is_backfill` marks them so
 *     the dashboard's "relay online" check can ignore them — otherwise one
 *     flush would show the parked scooter as live for the next five minutes.
 */
class RelayBatchController extends Controller
{
    /** Matches BatchUploader.BATCH_SIZE; a larger claim is rejected outright. */
    private const MAX_ITEMS = 500;

    /** Decompression ceiling — a gzip bomb must not exhaust memory. */
    private const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

    /**
     * How recent a row must be to count as describing "now". Generous
     * relative to the relay's ~2s cadence so a slow flush over a weak hotspot
     * isn't misfiled as history.
     */
    private const LIVE_WINDOW_SEC = 120;

    /** Timestamps outside this range mean the clock never got a GPS fix. */
    private const MIN_YEAR = 2020;
    private const MAX_YEAR = 2100;

    /** 每批最多保留几条死信样本（诊断够用，不做全量副本）。 */
    private const DEAD_LETTER_PER_BATCH = 20;

    /** 死信表保留的总条数上限（环形覆盖）。 */
    private const DEAD_LETTER_KEEP = 2000;

    /** 单条死信 payload 的截断长度。 */
    private const DEAD_LETTER_PAYLOAD_BYTES = 2000;

    public function __invoke(Request $request): JsonResponse
    {
        // ── Body: gunzip before anything else ───────────────────────
        $raw = $request->getContent();

        if (str_contains(strtolower((string) $request->header('Content-Encoding', '')), 'gzip')) {
            $decoded = @gzdecode($raw, self::MAX_DECOMPRESSED_BYTES);
            if ($decoded === false) {
                return ApiResponder::error(
                    new ErrorObject('invalid_request_error', 'gzip_decode_failed', 'Request body is not valid gzip'),
                    400,
                );
            }
            // gzdecode truncates rather than failing when the limit is hit, so
            // check explicitly — otherwise the HMAC below would fail and
            // report a misleading "bad signature".
            if (strlen($decoded) >= self::MAX_DECOMPRESSED_BYTES) {
                return ApiResponder::error(
                    new ErrorObject('invalid_request_error', 'payload_too_large', 'Decompressed body exceeds limit'),
                    413,
                );
            }
            $raw = $decoded;
        }

        // ── Auth over the UNCOMPRESSED body ─────────────────────────
        $authError = RelayAuth::verify($raw, $request->bearerToken(), $request->header('X-Relay-Sig'));
        if ($authError !== null) {
            return ApiResponder::error($authError, 401);
        }

        // ── Envelope ────────────────────────────────────────────────
        $body = json_decode($raw, true);
        if (! is_array($body)) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'malformed_json', 'Body is not a JSON object'),
                422,
            );
        }

        $deviceSn = (string) ($body['device_sn'] ?? '');
        $items = $body['items'] ?? null;

        if ($deviceSn === '' || strlen($deviceSn) > 32 || ! is_array($items)) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'invalid_envelope', 'device_sn and items[] are required'),
                422,
            );
        }
        if (count($items) > self::MAX_ITEMS) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'batch_too_large', 'At most ' . self::MAX_ITEMS . ' items per batch'),
                422,
            );
        }
        if ($items === []) {
            // Nothing to do, but acknowledge so the client doesn't retry.
            return $this->ack(0, 0, 0, 0, null);
        }

        // The client sends ascending seq; sort defensively so a reordered
        // batch can't make last_seq acknowledge rows we never saw.
        usort($items, static fn ($a, $b) => ((int) ($a['seq'] ?? 0)) <=> ((int) ($b['seq'] ?? 0)));

        // ── Ingest ──────────────────────────────────────────────────
        $lastSeq = null;
        $accepted = 0;
        $duplicate = 0;
        $rejected = 0;
        $stoppedAt = null;
        /** @var list<int> */
        $rejectedSeqs = [];
        /** @var list<array<string, mixed>> */
        $deadLetters = [];

        foreach ($items as $item) {
            if (! is_array($item)) {
                // 连 seq 都读不出来，无从记账，也不能推进 last_seq。
                $rejected++;
                continue;
            }

            $seq = (int) ($item['seq'] ?? 0);
            $kind = (string) ($item['kind'] ?? '');
            $data = $item['data'] ?? null;

            if (! is_array($data)) {
                $rejected++;
                $rejectedSeqs[] = $seq;
                $this->stashDeadLetter($deadLetters, $deviceSn, $seq, $kind, 'malformed_item', $item);
                $lastSeq = $seq;
                continue;
            }

            try {
            $outcome = match ($kind) {
                'bms'  => $this->ingestBms($deviceSn, $data),
                'env'  => $this->ingestEnv($deviceSn, $data),
                'tpms_capture' => $this->ingestTpmsCapture($deviceSn, $data),
                default => 'rejected:unknown_kind',
            };
            } catch (\Throwable $e) {
                // A server-side fault (locked DB, disk full, schema drift) is
                // NOT the phone's problem. Stop here without acknowledging so
                // the row survives on the phone and the drain retries.
                Log::error('relay batch ingest failed', [
                    'device_sn' => $deviceSn,
                    'seq' => $seq,
                    'kind' => $kind,
                    'error' => $e->getMessage(),
                ]);
                $stoppedAt = $seq;
                break;
            }

            if ($outcome === 'accepted') {
                $accepted++;
            } elseif ($outcome === 'duplicate') {
                $duplicate++;
            } else {
                // 被拒 = 这一行马上就要随 ack 从手机上被删掉。落死信表，
                // 否则它连同「为什么被拒」一起永久消失（详见迁移注释）。
                $rejected++;
                $rejectedSeqs[] = $seq;
                $this->stashDeadLetter(
                    $deadLetters,
                    $deviceSn,
                    $seq,
                    $kind,
                    explode(':', $outcome, 2)[1] ?? 'unspecified',
                    $data,
                );
            }

            $lastSeq = $seq;
        }

        $this->flushDeadLetters($deadLetters);

        if ($lastSeq === null) {
            // Nothing durably stored. Must NOT be a 2xx — the client treats any
            // 2xx as permission to delete the batch.
            return ApiResponder::error(
                new ErrorObject('server_error', 'ingest_failed', 'No item could be stored; retry later'),
                500,
            );
        }

        return $this->ack($lastSeq, $accepted, $duplicate, $rejected, $stoppedAt, $rejectedSeqs);
    }

    /**
     * 把一条被拒条目暂存进本批次的死信缓冲。
     *
     * 只缓冲不落库：整批全拒时（时钟跑飞就是这种）一次 500 条单行 INSERT 会
     * 把回传拖垮，攒到最后一次性写。每批最多留 DEAD_LETTER_PER_BATCH 条样本
     * ——诊断只需要看清"长什么样"，不需要全量副本。
     *
     * @param  list<array<string, mixed>>  $bucket
     * @param  mixed  $payload
     */
    private function stashDeadLetter(
        array &$bucket,
        string $deviceSn,
        int $seq,
        string $kind,
        string $reason,
        $payload,
    ): void {
        if (count($bucket) >= self::DEAD_LETTER_PER_BATCH) {
            return;
        }

        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        $bucket[] = [
            'device_sn'  => $deviceSn,
            'seq'        => $seq,
            'kind'       => substr($kind, 0, 16),
            'reason'     => substr($reason, 0, 48),
            'payload'    => $json === false ? null : substr($json, 0, self::DEAD_LETTER_PAYLOAD_BYTES),
            'created_at' => now()->format('Y-m-d H:i:s'),
        ];
    }

    /**
     * 落库并做环形上限。
     *
     * 整个方法吞异常：死信表是诊断设施，绝不能反过来把它要诊断的回传链路
     * 弄挂——那样只会在故障时雪上加霜。
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function flushDeadLetters(array $rows): void
    {
        if ($rows === []) {
            return;
        }

        try {
            DB::table('relay_dead_letters')->insert($rows);

            // 环形上限：时钟跑飞会让每一批都全拒，没有天花板的话这张诊断表
            // 会长得比它要诊断的数据还大。只在真的有死信时才做这次 count。
            $overflow = DB::table('relay_dead_letters')->count() - self::DEAD_LETTER_KEEP;
            if ($overflow > 0) {
                $ids = DB::table('relay_dead_letters')
                    ->orderBy('id')
                    ->limit($overflow)
                    ->pluck('id');
                DB::table('relay_dead_letters')->whereIn('id', $ids)->delete();
            }
        } catch (\Throwable $e) {
            Log::warning('relay dead-letter write failed', ['error' => $e->getMessage()]);
        }
    }

    /**
     * Root key is 'data' on purpose: BatchUploader.parseLastSeq() looks for
     * `snapshot`, then `data`, then the root. A semantic key like
     * 'relay_batch' would fall through to the root, find no last_seq, and make
     * the client assume the entire batch landed.
     */
    /**
     * @param  list<int>  $rejectedSeqs
     */
    private function ack(
        int $lastSeq,
        int $accepted,
        int $duplicate,
        int $rejected,
        ?int $stoppedAt,
        array $rejectedSeqs = [],
    ): JsonResponse {
        return ApiResponder::success('data', [
            'last_seq'   => $lastSeq,
            'accepted'   => $accepted,
            'duplicate'  => $duplicate,
            'rejected'   => $rejected,
            'stopped_at' => $stoppedAt,
            // 明确点名哪些 seq 被丢了。中继当前只读 last_seq（老版本会忽略这个
            // 字段，不影响兼容），但服务端日志和人工排查从此有据可查。
            'rejected_seqs' => array_slice($rejectedSeqs, 0, self::DEAD_LETTER_PER_BATCH),
        ]);
    }

    // ── Per-kind ingestion ──────────────────────────────────────────

    /**
     * A board frame (or a phone-status heartbeat).
     *
     * @return string 'accepted' | 'duplicate' | 'rejected:<reason>'
     */
    private function ingestBms(string $deviceSn, array $d): string
    {
        $capturedAt = $this->parseInstant($d['captured_at'] ?? null);
        if ($capturedAt === null) {
            return 'rejected:bad_timestamp';
        }

        $isHeartbeat = ! empty($d['is_heartbeat']);
        $clockOk = ! empty($d['clock_disciplined']);
        $ageSec = now()->getTimestamp() - $capturedAt->getTimestamp();

        // Freshness is judged by the receive-vs-capture gap alone: an old sample
        // always carries an old captured_at (large ageSec), so a small ageSec
        // proves the sample is live regardless of whether the relay could
        // GPS-confirm its clock. A relay in a metal tail box may frequently
        // never gets a GPS time fix, yet its RTC is accurate to the second — the
        // old `!$clockOk` veto demoted every one of its live heartbeats to
        // backfill, and the dashboard read the relay as permanently offline.
        // clock_disciplined is still stored on the row (below) as an
        // ordering-trust hint for history, just no longer a liveness gate.
        $isBackfill = $ageSec > self::LIVE_WINDOW_SEC || $ageSec < -self::LIVE_WINDOW_SEC;

        // Heartbeats carry no board data, so the physical bar doesn't apply.
        if (! $isHeartbeat) {
            $problems = BmsSanity::check($d);
            if ($problems !== []) {
                Log::warning('relay batch dropped implausible frame', [
                    'device_sn' => $deviceSn,
                    'captured_at' => $capturedAt->toDateTimeString(),
                    'problems' => $problems,
                ]);
                return 'rejected:implausible_frame';
            }
        }

        // A heartbeat ALWAYS refreshes the single rolling status row — liveness
        // is judged purely by server receive time (upsertHeartbeat re-stamps
        // created_at = now()), never by the client's captured_at. The relay may sit in
        // a metal tail box with no GPS time fix; its RTC can drift past the
        // ±120s window, which used to flip every heartbeat into "backfill" and
        // skip the upsert — leaving the relayStatus rolling row stale and the
        // dashboard reading "offline" forever (A-10). captured_at stays on the
        // row only as an ordering/sort hint for history, not as a liveness gate.
        // Non-heartbeat frames still respect is_backfill (they become ordinary
        // historical rows instead of the live view).
        if ($isHeartbeat) {
            return $this->upsertHeartbeat($deviceSn, $capturedAt, $d);
        }

        $now = now()->format('Y-m-d H:i:s');
        $packVoltage = $this->floatOrNull($d['total_voltage_v'] ?? null);
        $packCurrent = $this->floatOrNull($d['current_a'] ?? null);
        $canonicalPower = $packVoltage !== null && $packCurrent !== null
            ? round($packVoltage * $packCurrent, 1)
            : $this->floatOrNull($d['power_w'] ?? null);
        $row = [
            'device_sn'   => $deviceSn,
            'captured_at' => $capturedAt->format('Y-m-d H:i:s'),

            'cell_count'            => $this->intOrNull($d['cell_count'] ?? null),
            'cells_mv'              => $this->jsonOrNull($d['cells_mv'] ?? null),
            'temps_c'               => $this->jsonOrNull($d['temps_c'] ?? null),
            'total_voltage_v'       => $packVoltage,
            'current_a'             => $packCurrent,
            'battery_status'        => $this->intOrNull($d['battery_status'] ?? null),
            'charge_mosfet_code'    => $this->intOrNull($d['charge_mosfet_code'] ?? null),
            'discharge_mosfet_code' => $this->intOrNull($d['discharge_mosfet_code'] ?? null),
            'balancer_code'         => $this->intOrNull($d['balancer_code'] ?? null),
            'soc_pct'               => $this->floatOrNull($d['soc_pct'] ?? null),
            'soh_pct'               => $this->floatOrNull($d['soh_pct'] ?? null),
            'power_w'               => $canonicalPower,
            'capacity_total_ah'     => $this->floatOrNull($d['capacity_total_ah'] ?? null),
            'capacity_remaining_ah' => $this->floatOrNull($d['capacity_remaining_ah'] ?? null),
            'cycle_capacity_ah'     => $this->floatOrNull($d['cycle_capacity_ah'] ?? null),
            'runtime_seconds'       => $this->intOrNull($d['runtime_seconds'] ?? null),
            'crc_ok'                => ! empty($d['crc_ok']) ? 1 : 0,
            'frame_hex'             => isset($d['frame_hex']) ? (string) $d['frame_hex'] : null,
            'parse_error'           => isset($d['parse_error']) ? (string) $d['parse_error'] : null,

            'phone_battery_level_pct' => $this->floatOrNull($d['phone_battery_level_pct'] ?? null),
            'phone_battery_temp_c'    => $this->floatOrNull($d['phone_battery_temp_c'] ?? null),
            'phone_battery_voltage_v' => $this->floatOrNull($d['phone_battery_voltage_v'] ?? null),
            'phone_charging'          => isset($d['phone_charging']) ? (! empty($d['phone_charging']) ? 1 : 0) : null,
            'phone_screen_on'         => isset($d['phone_screen_on']) ? (! empty($d['phone_screen_on']) ? 1 : 0) : null,

            'gps_lat'         => $this->floatOrNull($d['gps_lat'] ?? null),
            'gps_lon'         => $this->floatOrNull($d['gps_lon'] ?? null),
            'gps_speed_mps'   => $this->floatOrNull($d['gps_speed_mps'] ?? null),
            'gps_accuracy_m'  => $this->floatOrNull($d['gps_accuracy_m'] ?? null),
            'gps_altitude_m'  => $this->floatOrNull($d['gps_altitude_m'] ?? null),

            'board_connected'   => ! empty($d['board_connected']) ? 1 : 0,
            'is_heartbeat'      => 0,
            'is_backfill'       => $isBackfill ? 1 : 0,
            // The relay's only upload path is this batch endpoint (BatchUploader),
            // so every row ingested here is relay-sourced. Marks it distinct from the
            // dashboard phone's own BLE reads, which arrive via /bms-live-snapshot.
            'source'            => 'relay',
            'gps_only'          => 0,
            'riding'            => ! empty($d['riding']) ? 1 : 0,
            'clock_disciplined' => $clockOk ? 1 : 0,
            'pending_rows'      => $this->intOrNull($d['pending_rows'] ?? null),

            'created_at' => $now,
            'updated_at' => $now,
        ];

        // insertOrIgnore against the partial unique index on
        // (device_sn, captured_at) WHERE is_heartbeat = 0 — an interrupted
        // flush can be replayed wholesale without duplicating anything.
        $inserted = DB::table('bms_live_snapshots')->insertOrIgnore($row);

        // Also run this on an idempotent replay. The relay may publish the
        // newest frame first as a live preview, then replay it in sequence
        // after older backlog rows. firstOrCreate inside the interval service
        // makes this safe and fills the final interval once its predecessor
        // has arrived.
        if (! empty($d['crc_ok']) && $canonicalPower !== null) {
            app(BmsEnergyIntervalService::class)->recordFrame(
                $deviceSn,
                \Illuminate\Support\Carbon::instance($capturedAt),
                $canonicalPower,
            );
        }
        if (! $isBackfill && ! empty($d['crc_ok'])) {
            app(\App\Services\Battery\ChargingStateService::class)->ingest(
                $deviceSn,
                \Illuminate\Support\Carbon::instance($capturedAt),
                $packVoltage,
                $packCurrent,
                $this->floatOrNull($d['soc_pct'] ?? null),
                is_array($d['temps_c'] ?? null) ? $d['temps_c'] : null,
                array_key_exists('riding', $d) ? (bool) $d['riding'] : null,
                $this->floatOrNull($d['gps_speed_mps'] ?? null),
            );
        }

        // Board frames carry position while riding; mirror them into the trail
        // table so a ride's track is one narrow indexed query instead of a
        // scan over the wide snapshot table.
        return $inserted > 0 ? 'accepted' : 'duplicate';
    }

    /**
     * The rolling one-row-per-device phone status.
     */
    private function upsertHeartbeat(string $deviceSn, Carbon $capturedAt, array $d): string
    {
        $snap = BmsLiveSnapshot::updateOrCreate(
            ['device_sn' => $deviceSn, 'is_heartbeat' => 1],
            [
                'captured_at'             => $capturedAt,
                'phone_battery_level_pct' => $this->floatOrNull($d['phone_battery_level_pct'] ?? null),
                'phone_battery_temp_c'    => $this->floatOrNull($d['phone_battery_temp_c'] ?? null),
                'phone_battery_voltage_v' => $this->floatOrNull($d['phone_battery_voltage_v'] ?? null),
                'phone_charging'          => ! empty($d['phone_charging']),
                'phone_screen_on'         => ! empty($d['phone_screen_on']),
                'board_connected'         => ! empty($d['board_connected']),
                'pending_rows'            => $this->intOrNull($d['pending_rows'] ?? null),
                'clock_disciplined'       => ! empty($d['clock_disciplined']),
                'is_backfill'             => 0,
                'is_heartbeat'            => 1,
                'source'                  => 'relay',
                // NOTE: 必须先清洗非法字节、再按「字符」截断。
                // 必须先清洗再按字符截断；按字节截断多字节文本会产生非法 UTF-8。
                // SQLite 不强制 varchar(120) 长度，故可安全放宽到 200 字符。
                'ble_status'              => isset($d['ble_status'])
                    ? mb_substr(
                        iconv('UTF-8', 'UTF-8//IGNORE', (string) $d['ble_status']) ?: '',
                        0,
                        200,
                        'UTF-8'
                    )
                    : null,
                'ble_state'               => isset($d['ble_state'])
                    ? substr((string) $d['ble_state'], 0, 32)
                    : null,
                'app_ver'                 => isset($d['app_ver'])
                    ? substr((string) $d['app_ver'], 0, 32)
                    : null,
            ],
        );

        // Eloquent refuses to touch created_at on the update path, but
        // relayStatus measures liveness by server receive time — without this
        // the relay reads "offline" five minutes after the row was created.
        $snap->created_at = now();
        $snap->saveQuietly();

        // ── 此行以下全是「已落库之后」的副作用 ──────────────────────
        //
        // 心跳这一刻已经durably存下了，ack 的承诺已经可以兑现。后面这两件事
        // ——发板子掉线告警、给 update_apk 命令结案——都是记账性质的附加动作，
        // 失败了不影响任何数据完整性。
        //
        // 但如果让它们的异常往上冒，__invoke 的 catch 会把整条批次判成
        // 「服务端故障」→ break + 500 → 中继认为心跳没存下、原地重试。
        // 辅助命令处理异常不能让已持久化的心跳被客户端重复发送；板子帧和
        // 心跳采用不同路径，因此这里必须隔离失败。
        //
        // 所以这里吞掉并告警：已经存下的事实，不能被事后的副作用推翻。
        try {
            $this->noteBoardTransition($deviceSn, ! empty($d['board_connected']), 0);

            // 中继回报了 app_ver：若它比 update_apk 下发时的版本新，说明自更新已落地，
            // 把卡在 pending/dispatched 的 update_apk 自动结案（root 静默安装时进程可能在
            // 回报 HTTP 前就被替换，命令会永远停在「执行中」）。详见 RelayCommand.issued_app_ver。
            $this->resolveRelayUpdateCommands($deviceSn, $d['app_ver'] ?? null);
        } catch (\Throwable $e) {
            Log::error('heartbeat side-effect failed (row already stored)', [
                'device_sn' => $deviceSn,
                'error' => $e->getMessage(),
            ]);
        }

        return 'accepted';
    }

    /**
     * An ambient climate reading from the Xiaomi LYWSD03MMC (pvvx firmware,
     * plaintext 0x181A broadcast). Written into env_samples with the same
     * insertOrIgnore idempotency as the board frames.
     *
     * @return string 'accepted' | 'duplicate' | 'rejected:<reason>'
     */
    private function ingestEnv(string $deviceSn, array $d): string
    {
        $capturedAt = $this->parseInstant($d['captured_at'] ?? null);
        if ($capturedAt === null) {
            return 'rejected:bad_timestamp';
        }

        $problems = EnvSanity::check($d);
        if ($problems !== []) {
            Log::warning('relay batch dropped implausible env', [
                'device_sn' => $deviceSn,
                'problems' => $problems,
            ]);
            return 'rejected:implausible_env';
        }

        $now = now()->format('Y-m-d H:i:s');
        $inserted = DB::table('env_samples')->insertOrIgnore([
            'device_sn'         => $deviceSn,
            'sensor_mac'        => isset($d['sensor_mac']) ? substr((string) $d['sensor_mac'], 0, 17) : null,
            'temp_c'            => $this->floatOrNull($d['temp_c'] ?? null),
            'humidity_pct'      => $this->floatOrNull($d['humidity_pct'] ?? null),
            'sensor_battery_mv' => $this->intOrNull($d['sensor_battery_mv'] ?? null),
            'rssi'              => $this->intOrNull($d['rssi'] ?? null),
            'captured_at'       => $capturedAt->format('Y-m-d H:i:s'),
            'created_at'        => $now,
            'updated_at'        => $now,
        ]);

        return $inserted > 0 ? 'accepted' : 'duplicate';
    }

    /**
     * A raw BLE advertisement PDU captured from a compatible TPMS
     * sensor. This is a DEBUG-ONLY landing zone: the relay ships us the whole
     * advert (full PDU base64 + manufacturer/service-data maps) so we can
     * reverse-engineer the pressure/temp encoding off-device. Task #9 will
     * replace this with parsed, validated fields on the live snapshot.
     *
     * @return string 'accepted' | 'duplicate' | 'rejected:<reason>'
     */
    private function ingestTpmsCapture(string $deviceSn, array $d): string
    {
        $capturedAt = $this->parseInstant($d['captured_at'] ?? null);
        if ($capturedAt === null) {
            return 'rejected:bad_timestamp';
        }

        $sensorName = isset($d['sensor_name']) ? substr((string) $d['sensor_name'], 0, 32) : null;
        if ($sensorName === null || $sensorName === '') {
            return 'rejected:missing_sensor_name';
        }

        $mac = isset($d['mac']) ? substr((string) $d['mac'], 0, 17) : null;

        // The relay sends the full PDU as base64; keep it verbatim (it is the
        // source of truth for decoding downstream).
        $raw = is_string($d['raw_bytes'] ?? null) ? $d['raw_bytes'] : null;

        // Manufacturer/service-data maps arrive as assoc arrays; store as JSON.
        $manu = (isset($d['manufacturer_data']) && is_array($d['manufacturer_data']))
            ? json_encode($d['manufacturer_data'])
            : null;
        $svc = (isset($d['service_data']) && is_array($d['service_data']))
            ? json_encode($d['service_data'])
            : null;

        $now = now()->format('Y-m-d H:i:s');
        $inserted = DB::table('tpms_captures')->insertOrIgnore([
            'device_sn'         => $deviceSn,
            'sensor_name'       => $sensorName,
            'mac'               => $mac,
            'rssi'              => $this->intOrNull($d['rssi'] ?? null),
            'raw_bytes'         => $raw,
            'manufacturer_data' => ($manu === false) ? null : $manu,
            'service_data'      => ($svc === false) ? null : $svc,
            'captured_at'       => $capturedAt->format('Y-m-d H:i:s'),
            'created_at'        => $now,
            'updated_at'        => $now,
        ]);

        return $inserted > 0 ? 'accepted' : 'duplicate';
    }

    // ── Helpers ─────────────────────────────────────────────────────

    /**
     * Fire the board-detached alert on a true→false edge only, mirroring the
     * live endpoint (HealthController::notify dedupes within 15 min anyway).
     */
    private function noteBoardTransition(string $deviceSn, bool $boardNow, int $unused): void
    {
        $key = "relay:board:{$deviceSn}";
        $wasConnected = Cache::get($key, false);
        if ($wasConnected && ! $boardNow) {
            HealthController::notify(
                "board_detached:{$deviceSn}",
                "BMS relay for {$deviceSn} lost the ANT board connection.",
            );
        } elseif (! $wasConnected && $boardNow) {
            HealthController::notifyRecovery(
                "board_detached:{$deviceSn}",
                "BMS relay for {$deviceSn} restored the ANT board connection.",
            );
        }
        Cache::put($key, $boardNow, now()->addHours(6));
    }

    /**
     * 心跳对账：当中继回报的 app_ver 比某条 update_apk 下发时的版本新，说明自更新
     * 已落地，把仍停留在 pending/dispatched 的命令自动结案为 done。
     *
     * 背景：root 静默安装会替换运行中的 APK，进程可能在回报 HTTP 前就被重启，
     * 导致命令永远停在「执行中」。这里不依赖中继回传结果，纯靠「版本变新」判定，
     * 因此即便是已经卡住的历史命令也能在下次心跳时被清掉（issued_app_ver 为 null
     * 且命令已超 5 分钟、中继此刻在线也结，避免误清刚下发还没执行的命令）。
     */
    private function resolveRelayUpdateCommands(string $deviceSn, ?string $newVer): void
    {
        if ($newVer === null || $newVer === '') {
            return;
        }

        // 含 'expired'：中继装完新版就重启，往往赶不及回报 HTTP，命令会先被
        // evtelemetry:sweep-commands 判成 expired。等它下次心跳带上更新后的版本号，
        // 这里再把结论修正为 done——版本变新是「更新确实落地」的硬证据。
        $cmds = RelayCommand::where('device_sn', $deviceSn)
            ->where('command', 'update_apk')
            ->whereIn('status', ['pending', 'dispatched', 'expired'])
            ->get();

        foreach ($cmds as $c) {
            $issued = $c->issued_app_ver;
            $resolve = false;

            if ($issued !== null && $issued !== '' && version_compare($newVer, $issued, '>')) {
                $resolve = true;
            } elseif ($issued === null && $c->created_at && $c->created_at->lt(now()->subMinutes(5))) {
                // 老命令（迁移前没有 issued_app_ver）：中继此刻在线且已回报版本，
                // 超 5 分钟还没执行就视为已随更新完成，结案。
                $resolve = true;
            }

            if (! $resolve) {
                continue;
            }

            $c->status = 'done';
            $c->result = array_merge($c->result ?? [], [
                'note' => 'relay 回报新版本，自动结案',
            ]);
            // 若之前被 sweep 判过 expired，这里连同它写的失败原因一起抹掉，
            // 否则仪表盘会出现「已完成」却挂着一条超时错误的矛盾展示。
            $c->error = null;
            $c->executed_at = now();
            $c->saveQuietly();
        }
    }

    /**
     * Parse an ISO-8601 instant into app-local time.
     *
     * The relay always emits UTC with a trailing Z; every other datetime in
     * this database is Asia/Shanghai. Converting here (rather than letting the
     * datetime cast format UTC digits verbatim) is what makes these rows
     * comparable with device_ride_history for time matching.
     */
    private function parseInstant(mixed $v): ?Carbon
    {
        if (! is_string($v) || $v === '') {
            return null;
        }

        try {
            $c = Carbon::parse($v);
        } catch (\Throwable) {
            return null;
        }

        // A phone that never got a GPS fix can report 1970 or 2036. Those would
        // poison every range query, and no amount of downstream filtering
        // recovers a row whose timestamp is meaningless.
        if ($c->year < self::MIN_YEAR || $c->year > self::MAX_YEAR) {
            return null;
        }

        return $c->setTimezone(config('app.timezone'));
    }

    private function floatOrNull(mixed $v): ?float
    {
        return is_numeric($v) ? (float) $v : null;
    }

    private function intOrNull(mixed $v): ?int
    {
        return is_numeric($v) ? (int) $v : null;
    }

    private function jsonOrNull(mixed $v): ?string
    {
        if (! is_array($v) || $v === []) {
            return null;
        }
        $encoded = json_encode(array_values($v));
        return $encoded === false ? null : $encoded;
    }
}
