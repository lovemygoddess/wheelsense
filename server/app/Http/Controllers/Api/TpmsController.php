<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * GET /api/tpms/current — 结构化胎压读数（Task #9 落地部分）。
 *
 * Verified 0x1E01 TPMS payload:
 *   - byte0 is temperature raw (°C = byte0 - 40)
 *   - byte1 is pressure raw (bar = byte1 × 0.02)
 *   - byte0 + byte1 + byte2 must equal 224
 *   - wheel identity is configured through TPMS_FRONT_MAC/TPMS_REAR_MAC;
 *     no device identifiers are bundled in this repository.
 *
 * 前端/relay 无需改动：relay 已把原始 PDU 落 tpms_captures，后端在此服务端解码。
 */
class TpmsController extends Controller
{
    private const VERIFIED_COMPANY_ID = 0x1E01;
    private const CHECKSUM_BASE = 224;
    private const STALE_AFTER_SECONDS = 30 * 60;

    public function current(Request $request): JsonResponse
    {
        return response()->json($this->readings());
    }

    /** Shared decoded readings for normal screens and the native widget. */
    public function readings(): array
    {
        return [
            'ok' => true,
            'generated_at' => now()->toIso8601String(),
            'front' => $this->decodeWheel((string) config('tpms.front_mac', ''), 'front'),
            'rear'  => $this->decodeWheel((string) config('tpms.rear_mac', ''), 'rear'),
            'temp_available' => true,
            'temp_note' => '胎温按已验证的 0x1E01 协议 byte0 - 40°C 解码；仅采用校验和通过的广播帧。',
            'note' => '服务端只解码已验证的 0x1E01 广播，并将超过 30 分钟的最后有效值标记为 stale。',
        ];
    }

    private function decodeWheel(string $mac, string $pos): array
    {
        if ($mac === '') {
            return [
                'position' => $pos, 'pressure' => null, 'temp_c' => null,
                'token' => null, 'rssi' => null, 'updated_at' => null,
                'age_seconds' => null, 'capture_id' => null,
                'status' => 'not_configured', 'note' => '未配置胎压传感器 MAC',
            ];
        }
        $rows = DB::table('tpms_captures')
            ->where('mac', $mac)
            ->whereNotNull('raw_bytes')
            ->orderByDesc('id')
            ->limit(24)
            ->get();

        if ($rows->isEmpty()) {
            return [
                'position' => $pos, 'pressure' => null, 'temp_c' => null,
                'token' => null, 'rssi' => null, 'updated_at' => null,
                'age_seconds' => null, 'capture_id' => null,
                'status' => 'no_data', 'note' => '暂无抓包',
            ];
        }

        $row = null;
        $pressure = null;
        $token = null;
        $temp = null;
        $checksumOk = null;

        foreach ($rows as $candidate) {
            $blob = base64_decode((string) $candidate->raw_bytes, true);
            if ($blob === false) continue;
            foreach ($this->manuBlocks($blob) as [$cid, $payload]) {
                if ($cid !== self::VERIFIED_COMPANY_ID) continue;
                $p = rtrim($payload, "\x00");
                if (strlen($p) < 3) continue;
                $b0 = ord($p[0]); $b1 = ord($p[1]); $b2 = ord($p[2]);
                $checksumOk = ($b0 + $b1 + $b2) === self::CHECKSUM_BASE;
                if (!$checksumOk) continue;
                $temp = $b0 - 40;
                $pressure = round($b1 * 0.02, 2);
                $token = $this->asciiToken($p);
                $row = $candidate;
                break 2;
            }
        }

        if ($row === null) {
            $latest = $rows->first();
            return [
                'position' => $pos, 'pressure' => null, 'temp_c' => null,
                'token' => null, 'rssi' => $latest?->rssi, 'updated_at' => null,
                'age_seconds' => null, 'capture_id' => null,
                'checksum_ok' => false, 'status' => 'invalid_frame',
                'note' => '最近已验证 0x1E01 广播未通过完整性校验',
            ];
        }

        $age = isset($row->captured_at) ? (time() - strtotime($row->captured_at)) : null;

        return [
            'position' => $pos,
            'pressure' => $pressure,
            'temp_c' => $temp,
            'temp_candidate' => false,
            'checksum_ok' => $checksumOk,
            'token' => $token,
            'rssi' => $row->rssi,
            'updated_at' => $row->captured_at,
            'age_seconds' => $age,
            'capture_id' => $row->id,
            'status' => ($pressure === null) ? 'no_frame' : (($age !== null && $age > self::STALE_AFTER_SECONDS) ? 'stale' : 'ok'),
        ];
    }

    /** 解析 PDU，产出每个 0xFF 厂商专用 AD 的 [company_id_le, payload]。 */
    private function manuBlocks(string $blob): array
    {
        $out = [];
        $i = 0;
        $n = strlen($blob);
        while ($i + 1 < $n) {
            $len = ord($blob[$i]);
            if ($len === 0) {
                break;
            }
            $type = ord($blob[$i + 1]);
            $dataLen = $len - 1;
            $data = substr($blob, $i + 2, $dataLen);
            if ($type === 0xFF && strlen($data) >= 2) {
                $cid = ord($data[0]) | (ord($data[1]) << 8);
                $out[] = [$cid, substr($data, 2)];
            }
            $i += $len + 1;
        }
        return $out;
    }

    private function asciiToken(string $p): string
    {
        $printable = true;
        for ($k = 0; $k < strlen($p); $k++) {
            $c = ord($p[$k]);
            if ($c < 0x20 || $c > 0x7E) {
                $printable = false;
                break;
            }
        }
        return $printable ? $p : bin2hex($p);
    }
}
