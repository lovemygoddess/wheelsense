<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * GET /api/tpms/current — 结构化胎压读数（Task #9 落地部分）。
 *
 * 解码结论（基于 BLE 抓包与可信参考读数标定）：
 *   - 真实传感器 BLE 名 JH.TPMS，company id 0x1E00/0x1E01/0x1E02。
 *   - 传感器约每 10 分钟心跳广播一次，
 *     并在胎压/胎温变化或车轮转动时立即补播；非“仅事件触发”。
 *   - 胎压(bar) = (byte0 + 151) / 100；部署者应使用可信胎压计复核并按需调整。
 *   - 帧校验和（已验证 96/96=100%）：byte0 + byte1 + byte2 + (company_id & 0xFF) = 225。
 *       → byte2 是校验和凑位字段，byte1 是胎温字节。
 *   - 胎温 T(°C) = slope×byte1 + intercept；前后轮模型通过环境变量分别配置。
 *
 * 前端/relay 无需改动：relay 已把原始 PDU 落 tpms_captures，后端在此服务端解码。
 */
class TpmsController extends Controller
{
    // 胎压(bar) = (byte0 + PRESSURE_OFFSET) / PRESSURE_SCALE。
    // 默认值仅为协议示例；部署时应使用可信胎压计复核。
    private const PRESSURE_SCALE = 100.0;
    private const PRESSURE_OFFSET = 151;
    // 胎温（°C）= slope × byte1 + intercept；斜率和截距由环境变量配置。
    private const CHECKSUM_BASE = 225;   // byte0+byte1+byte2+(cid&0xFF) 恒等于此
    private const TPMS_COMPANY_IDS = [0x1E00, 0x1E01, 0x1E02];

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
            'front' => $this->decodeWheel((string) env('TPMS_FRONT_MAC', ''), 'front'),
            'rear'  => $this->decodeWheel((string) env('TPMS_REAR_MAC', ''), 'rear'),
            'temp_available' => true,
            'temp_note' => '胎温使用可配置的线性模型 T(°C)=slope×byte1+intercept，请用可信温度计标定。',
            'note' => '胎压传感器约每 10 分钟心跳广播一次，并在胎压、胎温变化或车轮转动时补播；relay 为被动嗅探，若某次广播未被抓到，读数可能滞后到下一次心跳才刷新。',
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
        $row = DB::table('tpms_captures')
            ->where('mac', $mac)
            ->whereNotNull('raw_bytes')
            ->orderByDesc('id')
            ->first();

        if (!$row) {
            return [
                'position' => $pos, 'pressure' => null, 'temp_c' => null,
                'token' => null, 'rssi' => null, 'updated_at' => null,
                'age_seconds' => null, 'capture_id' => null,
                'status' => 'no_data', 'note' => '暂无抓包',
            ];
        }

        $blob = base64_decode($row->raw_bytes);
        $pressure = null;
        $token = null;
        $temp = null;
        $checksumOk = null;

        foreach ($this->manuBlocks($blob) as [$cid, $payload]) {
            if (!in_array($cid, self::TPMS_COMPANY_IDS, true)) {
                continue;
            }
            // relay 解析时偶有尾随 0x00 填充，去掉。
            $p = rtrim($payload, "\x00");
            if (strlen($p) < 3) {
                continue;
            }
            $b0 = ord($p[0]);
            $b1 = ord($p[1]);
            $b2 = ord($p[2]);
            $pressure = round(($b0 + self::PRESSURE_OFFSET) / self::PRESSURE_SCALE, 2);
            // 胎温：byte1 是数据字节（byte2 为校验和凑位）。按 MAC 线性模型解码
            //（斜率/截距由九号官方 app 常温+热胎两点拟合，见 TEMP_MODEL）。
            $prefix = $pos === 'front' ? 'TPMS_FRONT' : 'TPMS_REAR';
            $model = [
                'slope' => (float) env($prefix.'_TEMP_SLOPE', 1.0),
                'intercept' => (float) env($prefix.'_TEMP_INTERCEPT', -80.0),
            ];
            $temp = round($model['slope'] * $b1 + $model['intercept'], 1);
            // 校验和自验：byte0+byte1+byte2+(cid&0xFF) === 225
            $checksumOk = ($b0 + $b1 + $b2 + ($cid & 0xFF)) === self::CHECKSUM_BASE;
            $token = $this->asciiToken($p);
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
            'status' => ($pressure === null) ? 'no_frame' : 'ok',
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
