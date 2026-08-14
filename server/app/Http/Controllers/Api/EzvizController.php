<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\EzvizApiService;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * EZVIZ camera proxy — keeps AppSecret server-side.
 * All endpoints throw 503 until EZVIZ_APP_KEY/EZVIZ_APP_SECRET are set.
 */
class EzvizController extends Controller
{
    public function __construct(
        private readonly EzvizApiService $ezviz,
    ) {}

    /** GET /api/ezviz/devices */
    public function devices(): JsonResponse
    {
        if (!$this->ezviz->isConfigured()) {
            return $this->notConfigured();
        }
        try {
            $list = $this->ezviz->listDevices();
            // Enrich each camera with battery level + signal from the status
            // endpoint. Battery cams report `battryStatus` (official typo);
            // mains cams report -1/-2 → normalized to null. A per-device
            // failure (offline camera) must not kill the whole list.
            $list = array_map(function ($device) {
                $device['battery'] = null;
                $device['signal'] = null;
                $serial = $device['deviceSerial'] ?? null;
                if ($serial) {
                    try {
                        $st = $this->ezviz->deviceStatus((string) $serial);
                        $batt = $st['battryStatus'] ?? null;
                        $device['battery'] = is_numeric($batt) && (int) $batt >= 0 ? (int) $batt : null;
                        $sig = $st['signal'] ?? null;
                        $device['signal'] = is_numeric($sig) && (int) $sig >= 0 ? (int) $sig : null;
                    } catch (\Throwable) {
                        // offline / unsupported — leave nulls
                    }
                }
                return $device;
            }, is_array($list) ? $list : []);

            return ApiResponder::success('devices', ['list' => $list]);
        } catch (\Throwable $e) {
            return ApiResponder::error(
                new ErrorObject('upstream_error', 'ezviz_api_error', 'EZVIZ request failed. Check server logs for a non-sensitive diagnostic.'),
                502,
            );
        }
    }

    /** GET /api/ezviz/live/{deviceSerial} */
    public function live(string $deviceSerial, Request $request): JsonResponse
    {
        if (!$this->ezviz->isConfigured()) {
            return $this->notConfigured();
        }
        $channelNo = max(1, (int) ($request->query('channel') ?? 1));
        try {
            return ApiResponder::success('live', ['streams' => $this->ezviz->liveVideo($deviceSerial, $channelNo)]);
        } catch (\Throwable $e) {
            return ApiResponder::error(
                new ErrorObject('upstream_error', 'ezviz_api_error', 'EZVIZ request failed. Check server logs for a non-sensitive diagnostic.'),
                502,
            );
        }
    }

    /**
     * GET /api/ezviz/live-url/{deviceSerial} — fresh accessToken + serial for
     * the embedded player. The token is ALSO stashed in the dashboard session
     * so the /ezviz/player page can read it server-side: putting the token in
     * the player URL leaked it into browser history / Referer headers (B14).
     */
    public function liveUrl(string $deviceSerial, Request $request): JsonResponse
    {
        if (!$this->ezviz->isConfigured()) {
            return $this->notConfigured();
        }
        try {
            $token = $this->ezviz->getAccessToken();

            // Wake the camera up with a capture request first — fire and
            // forget. The old sleep(3) blocked the single-threaded serve
            // worker (and the whole dashboard with it); the player retries
            // internally while the camera wakes.
            try {
                $this->ezviz->capture($deviceSerial, 1);
            } catch (\Throwable) {
                // non-fatal
            }

            // Session hand-off for the gated player page (no token in URL).
            $request->session()->put('ezviz_player', [
                'token' => $token,
                'serial' => $deviceSerial,
                'issued_at' => time(),
            ]);

            return ApiResponder::success('live_url', [
                'accessToken' => $token,
                'deviceSerial' => $deviceSerial,
                'player_url' => '/ezviz/player?serial=' . rawurlencode($deviceSerial),
            ]);
        } catch (\Throwable $e) {
            return ApiResponder::error(
                new ErrorObject('upstream_error', 'ezviz_api_error', 'EZVIZ request failed. Check server logs for a non-sensitive diagnostic.'),
                502,
            );
        }
    }

    /** GET /api/ezviz/snapshot-url/{deviceSerial} — returns a direct snapshot image URL */
    public function snapshotUrl(string $deviceSerial): JsonResponse
    {
        if (!$this->ezviz->isConfigured()) {
            return $this->notConfigured();
        }
        try {
            $picUrl = $this->ezviz->capture($deviceSerial, 1);
            return ApiResponder::success('snapshot_url', ['url' => $picUrl]);
        } catch (\Throwable $e) {
            return ApiResponder::error(
                new ErrorObject('upstream_error', 'ezviz_api_error', 'EZVIZ request failed. Check server logs for a non-sensitive diagnostic.'),
                502,
            );
        }
    }

    /** GET /api/ezviz/alarms/{deviceSerial} */
    public function alarms(string $deviceSerial, Request $request): JsonResponse
    {
        if (!$this->ezviz->isConfigured()) {
            return $this->notConfigured();
        }
        $limit = max(1, min(50, (int) ($request->query('limit') ?? 20)));
        try {
            $raw = $this->ezviz->alarmList($deviceSerial, $limit);
            $alarms = array_map(fn ($item) => [
                'id'           => $item['alarmId'] ?? null,
                'title'        => $item['alarmName'] ?? null,
                'type'         => isset($item['alarmType']) ? (string) $item['alarmType'] : null,
                'time'         => isset($item['alarmTime'])
                    ? \Carbon\Carbon::createFromTimestampMs($item['alarmTime'], 'Asia/Shanghai')->format('m-d H:i')
                    : null,
                'picUrl'       => $item['alarmPicUrl'] ?? '',
                'description'  => null,
                'deviceSerial' => $item['deviceSerial'] ?? $deviceSerial,
            ], $raw);

            return ApiResponder::success('alarms', ['list' => $alarms, 'total' => count($alarms)]);
        } catch (\Throwable $e) {
            return ApiResponder::error(
                new ErrorObject('upstream_error', 'ezviz_api_error', 'EZVIZ request failed. Check server logs for a non-sensitive diagnostic.'),
                502,
            );
        }
    }

    private function notConfigured(): JsonResponse
    {
        return ApiResponder::error(
            new ErrorObject('invalid_request_error', 'ezviz_not_configured', '萤石云未配置 — 请在 .env 设置 EZVIZ_APP_KEY 和 EZVIZ_APP_SECRET'),
            503,
        );
    }
}
