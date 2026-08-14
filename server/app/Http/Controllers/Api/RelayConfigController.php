<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Device;
use App\Support\RelayAuth;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 中继（车尾箱手机）的可远程配置。
 *
 * 两个方向、两套鉴权：
 *  - pull：中继拉取（RelayAuth，POST 带 body 以便 HMAC 签名）。返回当前设备的
 *    采样/低功耗/温湿度配置，未设置时回落到默认值，便于中继首次启动即用默认值。
 *  - show / update：App 仪表盘（dashboard.gate 会话解锁）查看与保存。update 校验
 *    间隔合法范围、MAC 格式，避免中继拿到荒诞值把 GPS 采样卡死。
 *
 * 中继是离线优先的，所以 update 写下的配置要等中继下次轮询才生效——
 * 这与现有远控指令（拍照等）的异步模型一致。
 */
class RelayConfigController extends Controller
{
    private const DEFAULT_IDLE_MS = 30_000;    // 30 s — matches relay's hard-coded idle poll; the slider now drives both the read rate and the upload keepalive gate
    private const DEFAULT_RIDE_MS = 1_000;      // 1 Hz
    private const MIN_IDLE_MS = 1_000;
    private const MAX_IDLE_MS = 3_600_000;     // 60 min
    private const MIN_RIDE_MS = 200;
    private const MAX_RIDE_MS = 60_000;         // 60 s

    // 轮询：中继拉命令/配置 & 仪表盘刷新基础间隔。
    private const DEFAULT_POLL_MS = 3_000;     // 3 s — tighter than 5 s so riding telemetry + remote commands feel prompt (dashboard foreground already tightens to 1 s)
    private const MIN_POLL_MS = 1_000;
    private const MAX_POLL_MS = 60_000;
    // 上行间隔：中继向服务端推送保护板帧的节流（≈ HttpRelay 原写死的 2100ms）。
    // 由仪表板按「GPS 启用 + 骑行中」动态驱动：激进 1000ms / 缓慢 5000ms。
    private const DEFAULT_UPLOAD_MS = 3_000;
    private const MIN_UPLOAD_MS = 1_000;
    private const MAX_UPLOAD_MS = 10_000;
    // 监测时长：停车后保持骑行频率采样的秒数（ride-linger，覆盖 STOP_CONFIRM_MS）。
    private const DEFAULT_MONITOR_SEC = 180;    // 3 min
    private const MIN_MONITOR_SEC = 0;
    private const MAX_MONITOR_SEC = 600;        // 10 min

    /** 中继拉取配置（RelayAuth）。 */
    public function pull(Request $request): JsonResponse
    {
        $raw = $request->getContent();
        $authError = RelayAuth::verify($raw, $request->bearerToken(), $request->header('X-Relay-Sig'));
        if ($authError !== null) {
            return ApiResponder::error($authError, 401);
        }

        $body = json_decode($raw, true);
        $deviceSn = (string) ($body['device_sn'] ?? '');
        if ($deviceSn === '' || strlen($deviceSn) > 32) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'invalid_envelope', 'device_sn required'),
                422,
            );
        }

        $device = Device::where('sn', $deviceSn)->first();
        if ($device === null) {
            // 设备未同步出来也别报错：回默认配置，中继至少能正常采样。
            return ApiResponder::success('config', $this->defaults());
        }

        return ApiResponder::success('config', $this->effective($device));
    }

    /** App 查看某设备的中继配置（dashboard.gate）。 */
    public function show(Request $request): JsonResponse
    {
        $deviceSn = (string) $request->query('device_sn', '');
        if ($deviceSn === '') {
            $deviceSn = (string) Device::query()->orderBy('id')->value('sn');
        }
        if ($deviceSn === '') {
            return ApiResponder::error(
                new ErrorObject('not_found', 'no_device', 'No device available'),
                404,
            );
        }

        $device = Device::where('sn', $deviceSn)->first();
        if ($device === null) {
            return ApiResponder::success('config', $this->defaults());
        }

        return ApiResponder::success('config', $this->effective($device));
    }

    /** App 保存某设备的中继配置（dashboard.gate）。 */
    public function update(Request $request): JsonResponse
    {
        $d = $request->validate([
            'device_sn'     => ['required', 'string', 'max:32'],
            'idle_ms'       => ['nullable', 'integer', 'between:' . self::MIN_IDLE_MS . ',' . self::MAX_IDLE_MS],
            'ride_ms'       => ['nullable', 'integer', 'between:' . self::MIN_RIDE_MS . ',' . self::MAX_RIDE_MS],
            'low_power'     => ['nullable', 'boolean'],
            'thermo_mac'    => ['nullable', 'string', 'regex:/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/'],
            'poll_ms'       => ['nullable', 'integer', 'between:' . self::MIN_POLL_MS . ',' . self::MAX_POLL_MS],
            'monitor_secs'  => ['nullable', 'integer', 'between:' . self::MIN_MONITOR_SEC . ',' . self::MAX_MONITOR_SEC],
            'upload_ms'     => ['nullable', 'integer', 'between:' . self::MIN_UPLOAD_MS . ',' . self::MAX_UPLOAD_MS],
        ]);

        $device = Device::where('sn', $d['device_sn'])->first();
        if ($device === null) {
            return ApiResponder::error(
                new ErrorObject('not_found', 'device_not_found', 'Device not found'),
                404,
            );
        }

        // 只更新请求中实际提供的字段：validate() 只返回请求里出现的键，
        // 其余字段保持原值，避免「只改 poll_ms 却把温湿度 MAC 等静默清空」
        // （A-28）。
        if (array_key_exists('idle_ms', $d)) {
            $device->relay_sample_idle_ms = $d['idle_ms'];
        }
        if (array_key_exists('ride_ms', $d)) {
            $device->relay_sample_ride_ms = $d['ride_ms'];
        }
        if (array_key_exists('low_power', $d)) {
            $device->relay_low_power = (bool) $d['low_power'];
        }
        if (array_key_exists('thermo_mac', $d)) {
            $device->relay_thermo_mac = $d['thermo_mac'] !== null && $d['thermo_mac'] !== '' ? $d['thermo_mac'] : null;
        }
        if (array_key_exists('poll_ms', $d)) {
            $device->relay_poll_ms = $d['poll_ms'];
        }
        if (array_key_exists('monitor_secs', $d)) {
            $device->relay_monitor_secs = $d['monitor_secs'];
        }
        if (array_key_exists('upload_ms', $d)) {
            $device->relay_upload_ms = $d['upload_ms'];
        }
        $device->save();

        return ApiResponder::success('config', $this->effective($device));
    }

    /** @return array<string, mixed> */
    private function effective(Device $device): array
    {
        return [
            'device_sn'     => $device->sn,
            'idle_ms'       => $device->relay_sample_idle_ms ?? self::DEFAULT_IDLE_MS,
            'ride_ms'       => $device->relay_sample_ride_ms ?? self::DEFAULT_RIDE_MS,
            'low_power'     => (bool) ($device->relay_low_power ?? false),
            'thermo_mac'    => $device->relay_thermo_mac,
            'poll_ms'       => $device->relay_poll_ms ?? self::DEFAULT_POLL_MS,
            'monitor_secs'  => $device->relay_monitor_secs ?? self::DEFAULT_MONITOR_SEC,
            'upload_ms'     => $device->relay_upload_ms ?? self::DEFAULT_UPLOAD_MS,
        ];
    }

    /** @return array<string, mixed> */
    private function defaults(): array
    {
        return [
            'device_sn'    => null,
            'idle_ms'      => self::DEFAULT_IDLE_MS,
            'ride_ms'      => self::DEFAULT_RIDE_MS,
            'low_power'    => false,
            'thermo_mac'   => null,
            'poll_ms'      => self::DEFAULT_POLL_MS,
            'monitor_secs' => self::DEFAULT_MONITOR_SEC,
            'upload_ms'    => self::DEFAULT_UPLOAD_MS,
        ];
    }
}
