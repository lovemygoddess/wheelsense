<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\BmsLiveSnapshot;
use App\Models\DeviceSnapshot;
use App\Support\ApiResponder;
use App\Support\BmsSanity;
use App\Support\RelayAuth;
use Illuminate\Support\Facades\Cache;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * BMS live snapshot ingestion + retrieval.
 *
 * Episodic data: only exists when a human is physically within BLE range
 * with the BMS monitor page open. NOT a continuous feed.
 */
class BmsLiveSnapshotController extends Controller
{
    /**
     * POST /api/bms-live-snapshot
     *
     * Stores one parsed BMS frame. Physically sanity-checks all fields
     * before writing — invalid data is rejected with 422, not silently
     * stored.
     */
    public function store(Request $request): JsonResponse
    {
        // ── Authentication: two accepted callers ────────────────────
        // 1. The Android relay APK — Bearer token + HMAC body signature. It
        //    cannot hold a session, and a bearer token alone only proves
        //    "knows the secret", so a captured token could be replayed to
        //    inject forged board data; the second shared secret signs the body.
        // 2. The dashboard app itself — when a paired phone connects to the
        //    board directly on the BMS tab it posts its own frames. It already
        //    authenticates with a session cookie everywhere else, so we accept
        //    that instead of shipping the HMAC secret inside the JS bundle.
        //    (This route sits outside dashboard.gate for the relay's sake, but
        //    session middleware still runs on every api route.)
        $hasSession = $request->hasSession() && $request->session()->has('dashboard_unlocked');

        if (! $hasSession) {
            // Same two-secret check the batch endpoint uses — shared so the
            // bulk path can never drift onto a weaker bar than this one.
            $authError = RelayAuth::verify(
                $request->getContent(),
                $request->bearerToken(),
                $request->header('X-Relay-Sig'),
            );
            if ($authError !== null) {
                return ApiResponder::error($authError, 401);
            }
        }

        $data = $request->validate([
            'device_sn'             => ['required', 'string', 'max:32'],
            // 'date' (not 'string'): rejects garbage timestamps with 422 instead of
            // throwing inside Carbon::parse() / the datetime cast → 500.
            'captured_at'           => ['required', 'date'],
            'cell_count'            => ['nullable', 'integer', 'min:1', 'max:32'],
            'cells_mv'              => ['nullable', 'array'],
            'cells_mv.*'            => ['nullable', 'integer'],
            'total_voltage_v'       => ['nullable', 'numeric'],
            'current_a'             => ['nullable', 'numeric'],
            'battery_status'        => ['nullable', 'integer', 'min:0', 'max:5'],
            'charge_mosfet_code'    => ['nullable', 'integer', 'min:0', 'max:255'],
            'discharge_mosfet_code' => ['nullable', 'integer', 'min:0', 'max:255'],
            'balancer_code'         => ['nullable', 'integer', 'min:0', 'max:255'],
            'soc_pct'               => ['nullable', 'numeric'],
            'soh_pct'               => ['nullable', 'numeric'],
            'capacity_total_ah'     => ['nullable', 'numeric'],
            'capacity_remaining_ah' => ['nullable', 'numeric'],
            'power_w'               => ['nullable', 'numeric'],
            'temps_c'               => ['nullable', 'array'],
            'temps_c.*'             => ['nullable', 'numeric'],
            'runtime_seconds'       => ['nullable', 'integer'],
            'crc_ok'                => ['nullable', 'boolean'],
            'frame_hex'             => ['nullable', 'string'],
            'parse_error'           => ['nullable', 'string'],
            // Relay phone's own battery health (optional, always allowed).
            'phone_battery_level_pct' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'phone_battery_temp_c'    => ['nullable', 'numeric'],
            'phone_charging'          => ['nullable', 'boolean'],
            'phone_battery_voltage_v' => ['nullable', 'numeric'],
            'phone_screen_on'         => ['nullable', 'boolean'],
            'riding'                  => ['nullable', 'boolean'],
            'gps_speed_mps'           => ['nullable', 'numeric', 'min:0'],
            // Relay-reported liveness flags (optional). board_connected tells
            // the dashboard whether the ANT board was attached when this report
            // was produced; is_heartbeat marks the rolling phone-status row.
            'board_connected'         => ['nullable', 'boolean'],
            'is_heartbeat'            => ['nullable', 'boolean'],
        ]);

        // ── Physical sanity validation ──────────────────────────────
        $errors = $this->validatePhysical($data);
        if ($errors !== []) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'bms_data_out_of_range', implode('; ', $errors)),
                422,
            );
        }

        $isHeartbeat = ! empty($data['is_heartbeat']);

        // Both callers send `new Date().toISOString()` — UTC with a trailing Z.
        // Laravel's datetime cast would format those digits verbatim, leaving
        // captured_at 8h behind every other datetime column in this database
        // (see the 2026_08_01_100200 migration, which repairs the history).
        // Normalise on the way in so the column means what it says.
        $capturedAt = \Carbon\Carbon::parse($data['captured_at'])
            ->setTimezone(config('app.timezone'));

        $packVoltage = isset($data['total_voltage_v']) ? (float) $data['total_voltage_v'] : null;
        $packCurrent = isset($data['current_a']) ? (float) $data['current_a'] : null;
        $canonicalPower = $packVoltage !== null && $packCurrent !== null
            ? round($packVoltage * $packCurrent, 1)
            : ($data['power_w'] ?? null);

        $attrs = [
            'device_sn'             => $data['device_sn'],
            'captured_at'           => $capturedAt,
            'cell_count'            => $data['cell_count'] ?? null,
            'cells_mv'              => $data['cells_mv'] ?? null,
            'total_voltage_v'       => $packVoltage,
            'current_a'             => $packCurrent,
            'battery_status'        => $data['battery_status'] ?? null,
            'charge_mosfet_code'    => $data['charge_mosfet_code'] ?? null,
            'discharge_mosfet_code' => $data['discharge_mosfet_code'] ?? null,
            'balancer_code'         => $data['balancer_code'] ?? null,
            'soc_pct'               => $data['soc_pct'] ?? null,
            'soh_pct'               => $data['soh_pct'] ?? null,
            'capacity_total_ah'     => $data['capacity_total_ah'] ?? null,
            'capacity_remaining_ah' => $data['capacity_remaining_ah'] ?? null,
            'power_w'               => $canonicalPower,
            'temps_c'               => $data['temps_c'] ?? null,
            'runtime_seconds'       => $data['runtime_seconds'] ?? null,
            'crc_ok'                => $data['crc_ok'] ?? false,
            'frame_hex'             => $data['frame_hex'] ?? null,
            'parse_error'           => $data['parse_error'] ?? null,
            'phone_battery_level_pct' => $data['phone_battery_level_pct'] ?? null,
            'phone_battery_temp_c'    => $data['phone_battery_temp_c'] ?? null,
            'phone_charging'          => $data['phone_charging'] ?? null,
            'phone_battery_voltage_v' => $data['phone_battery_voltage_v'] ?? null,
            'phone_screen_on'         => $data['phone_screen_on'] ?? null,
            'riding'                => array_key_exists('riding', $data) ? (! empty($data['riding']) ? 1 : 0) : null,
            'gps_speed_mps'         => $data['gps_speed_mps'] ?? null,
            'board_connected'       => ! empty($data['board_connected']),
            // Only the dashboard phone (BMS tab, reading the board over its
            // own BLE) posts here now — the dedicated relay uses /relay/batch. Tag it so
            // relayLiveBms can tell "the relay read the board" apart from "the
            // dashboard phone read the board itself".
            'source'                => 'phone',
        ];

        if ($isHeartbeat) {
            // One rolling status row per device. The relay posts this every
            // ~15s even when no BMS frame arrives, so upsert (don't append) to
            // keep the table bounded while the relay app stays alive.
            $snap = BmsLiveSnapshot::updateOrCreate(
                ['device_sn' => $data['device_sn'], 'is_heartbeat' => 1],
                $attrs + ['is_heartbeat' => 1],
            );
            // updateOrCreate does NOT refresh created_at on the update path
            // (Eloquent protects it), so touch it explicitly — relayStatus
            // measures liveness by server receive time, which must stay fresh
            // on every heartbeat or the phone would read "offline" after 5 min.
            $snap->created_at = now();
            $snap->saveQuietly();

            // Board-detached alert: notify only on a true→false transition,
            // deduplicated inside HealthController::notify (15 min window).
            $boardNow = ! empty($data['board_connected']);
            $prevKey = "relay:board:{$data['device_sn']}";
            $wasConnected = Cache::get($prevKey, false);
            if ($wasConnected && ! $boardNow) {
                \App\Http\Controllers\Api\HealthController::notify(
                    "board_detached:{$data['device_sn']}",
                    "BMS relay for {$data['device_sn']} lost the ANT board connection.",
                );
            }
            Cache::put($prevKey, $boardNow, now()->addHours(6));
        } else {
            $snap = BmsLiveSnapshot::create($attrs + ['is_heartbeat' => 0]);
            if (! empty($data['crc_ok'])) {
                app(\App\Services\Battery\ChargingStateService::class)->ingest(
                    $data['device_sn'],
                    $capturedAt,
                    $packVoltage,
                    $packCurrent,
                    isset($data['soc_pct']) ? (float) $data['soc_pct'] : null,
                    $data['temps_c'] ?? null,
                    array_key_exists('riding', $data) ? (bool) $data['riding'] : null,
                    isset($data['gps_speed_mps']) ? (float) $data['gps_speed_mps'] : null,
                );
            }
        }

        // Attach nearby Ninebot snapshot for cross-verification (skip heartbeats,
        // which carry no board data and would attach a meaningless cross-check).
        if (! $isHeartbeat) {
            $ninebot = $this->nearestNinebotSnapshot($data['device_sn'], $snap->captured_at);
            if ($ninebot !== null) {
                $snap->ninebot_voltage_v = $ninebot->bms_voltage;
                $snap->ninebot_soc_pct   = $this->deriveNinebotSoc($ninebot);
                if ($snap->total_voltage_v !== null && $snap->ninebot_voltage_v !== null) {
                    $snap->voltage_diff_v = round($snap->ninebot_voltage_v - $snap->total_voltage_v, 3);
                }
                if ($snap->soc_pct !== null && $snap->ninebot_soc_pct !== null) {
                    $snap->soc_diff_pct = round($snap->ninebot_soc_pct - $snap->soc_pct, 1);
                }
                $snap->saveQuietly();
            }
        }

        return ApiResponder::success('snapshot', ['id' => $snap->id]);
    }

    /**
     * GET /api/bms-live-snapshot?device_sn=X&limit=1
     *
     * Returns latest snapshot + age indicator.
     */
    public function index(Request $request): JsonResponse
    {
        $request->validate([
            'device_sn' => ['required', 'string'],
            'limit'     => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);

        $limit = (int) ($request->query('limit') ?? 1);
        // Exclude rolling heartbeat rows: they refresh captured_at every 15s
        // (always the "latest") yet carry no board data, so returning them
        // makes the BMS page show "fresh" while every cell/temp field is null
        // (A-13). Board status must come from real frames only.
        $snaps = BmsLiveSnapshot::where('device_sn', $request->query('device_sn'))
            ->where('is_heartbeat', 0)
            ->orderByDesc('captured_at')
            ->limit($limit)
            ->get();

        $latest = $snaps->first();
        $ageSeconds = null;
        if ($latest && $latest->captured_at) {
            // Carbon 3: past->diffInSeconds(now) is positive for past timestamps.
            // max(0, ·) guards the APK-clock-running-ahead case where a future
            // captured_at would otherwise yield a negative age and make `fresh`
            // (age < 300) permanently true.
            $ageSeconds = max(0, (int) $latest->captured_at->diffInSeconds(now()));
        }

        return ApiResponder::success('snapshots', [
            'latest'      => $latest,
            'snapshots'   => $snaps,
            'age_seconds' => $ageSeconds,
            'fresh'       => $ageSeconds !== null && $ageSeconds < 300,
        ]);
    }

    // ── Private helpers ──────────────────────────────────────────

    /**
     * Physical sanity checks for NMC lithium cells.
     *
     * Delegates to the shared implementation so this endpoint and the bulk
     * relay endpoint can never diverge on what counts as a plausible frame.
     *
     * @return list<string>  error strings (empty = valid)
     */
    private function validatePhysical(array $data): array
    {
        return BmsSanity::check($data);
    }

    /**
     * Find the closest Ninebot device_snapshot within ±2 minutes of the
     * BMS capture time.
     */
    private function nearestNinebotSnapshot(string $deviceSn, $capturedAt): ?DeviceSnapshot
    {
        $deviceId = \App\Models\Device::where('sn', $deviceSn)->value('id');
        if ($deviceId === null) {
            return null;
        }

        $t = \Carbon\Carbon::parse($capturedAt);

        // Both `created_at` and the captured_at we compare against are stored
        // as naive local-time strings. strftime('%s', ...) forces UTC
        // interpretation and introduces a fixed 28800s (8h) offset that makes
        // ABS(...) collapse to the window's earliest row instead of the true
        // nearest neighbour (A-14). julianday on two same-format naive strings
        // cancels the offset, giving a correct delta.
        return DeviceSnapshot::where('device_id', $deviceId)
            ->whereBetween('created_at', [$t->copy()->subMinutes(2), $t->copy()->addMinutes(2)])
            ->orderByRaw('ABS(julianday(created_at) - julianday(?))', [$t->toDateTimeString()])
            ->first();
    }

    /**
     * Derive a SOC% from the Ninebot snapshot raw payload.
     */
    private function deriveNinebotSoc(DeviceSnapshot $snap): ?float
    {
        $raw = $snap->raw;
        if (!is_array($raw)) {
            return null;
        }
        // Ninebot returns remaining_mileage + estimate_mileage; we
        // approximate SOC as remaining/estimate if estimate > 0.
        $remain = $raw['remaining_mileage'] ?? null;
        $estimate = $snap->estimate_mileage;
        if ($estimate && $estimate > 0 && $remain !== null) {
            return round(min(100, max(0, ($remain / $estimate) * 100)), 1);
        }
        return null;
    }
}
