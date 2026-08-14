<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\BmsLiveSnapshot;
use App\Models\RelayCommand;
use App\Support\RelayAuth;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * 中继远控指令的双向通道。
 *
 *  - issue：仪表盘（session 解锁）下发指令，写 relay_commands。
 *  - poll：中继拉取待执行指令（RelayAuth，POST 带 body 以便 HMAC 签名）。
 *          乐观标记为 dispatched，APK 用指令 id 本地去重避免重复执行。
 *  - result：中继回传执行结果（RelayAuth）。
 *  - uploadPhoto：中继上传拍照结果（multipart，仅验 bearer token，见下方说明）。
 *  - listForDashboard：仪表盘查看指令历史。
 *
 * 安全说明：poll / result 走完整 RelayAuth（token + HMAC）。uploadPhoto 是
 * multipart 二进制，无法对原始体做 HMAC（APK 侧难以精确重建 boundary），
 * 故仅验证 bearer token——拍照属低风险操作，且 token 本身已能注入遥测，
 * 风险等级相当。若日后需要可对规范化元数据串做 HMAC 升级。
 */
class RelayCommandController extends Controller
{
    /** 仪表盘下发指令（需 session 解锁）。 */
    public function issue(Request $request): JsonResponse
    {
        $d = $request->validate([
            'device_sn'        => ['required', 'string', 'max:32'],
            'command'          => ['required', 'string', 'in:' . implode(',', RelayCommand::COMMANDS)],
            'payload'          => ['nullable', 'array'],
            'expires_minutes'  => ['nullable', 'integer', 'min:1', 'max:10080'],
        ]);

        $remoteControlEnabled = filter_var(env('ENABLE_RELAY_REMOTE_CONTROL', false), FILTER_VALIDATE_BOOL);
        if (! $remoteControlEnabled) {
            return ApiResponder::error(
                new ErrorObject(
                    'permission_error',
                    'relay_remote_control_disabled',
                    'Relay remote control is disabled. Enable it only for devices you own on a trusted private deployment.',
                ),
                403,
            );
        }

        $dangerousCommands = ['shutdown', 'reboot', 'restart', 'clear-backlog', 'update_apk', 'tap', 'swipe', 'key'];
        $dangerousEnabled = filter_var(env('ENABLE_DANGEROUS_RELAY_COMMANDS', false), FILTER_VALIDATE_BOOL);
        if (in_array($d['command'], $dangerousCommands, true) && ! $dangerousEnabled) {
            return ApiResponder::error(
                new ErrorObject(
                    'permission_error',
                    'dangerous_relay_commands_disabled',
                    'This command is disabled. Set ENABLE_DANGEROUS_RELAY_COMMANDS=true only on a trusted private deployment.',
                ),
                403,
            );
        }

        if ($d['command'] === 'clear-backlog' && (($d['payload']['confirmed'] ?? false) !== true)) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'confirmation_required', 'clear-backlog requires payload.confirmed=true'),
                422,
            );
        }

        $dangerous = in_array($d['command'], ['shutdown', 'reboot', 'restart', 'clear-backlog', 'update_apk'], true);
        $expires = isset($d['expires_minutes'])
            ? now()->addMinutes((int) $d['expires_minutes'])
            : ($dangerous ? now()->addMinutes(5) : now()->addHours(24));

        // 下发时记下中继当前的 app_ver，供心跳对账自动结案（见 RelayBatchController）。
        $issuedAppVer = BmsLiveSnapshot::where('device_sn', $d['device_sn'])
            ->where('is_heartbeat', 1)
            ->orderByDesc('created_at')
            ->value('app_ver');

        $cmd = RelayCommand::create([
            'device_sn'      => $d['device_sn'],
            'command'        => $d['command'],
            'payload'        => $d['payload'] ?? null,
            'issued_by'      => 'dashboard',
            'issued_app_ver' => $issuedAppVer,
            'client_token'   => Str::random(32),
            'expires_at'     => $expires,
        ]);

        return ApiResponder::success('command', $this->toArray($cmd), 201);
    }

    /** 中继拉取待执行指令（RelayAuth，POST 带 body 以便 HMAC）。 */
    public function poll(Request $request): JsonResponse
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

        // 原子领取：一条 UPDATE 抢占并打上本次调用独有的 claim_token，再按 token 回读。
        //
        // 旧实现是 SELECT 再逐行 save()，两步之间无互斥——poll 每 3 秒一次，网络
        // 抖动重发或新旧进程重叠时两次 poll 会读到同一批 pending，同一条 reboot /
        // shell 被派发两遍，attempts 还会因读-改-写而丢更新。SQLite 的单条 UPDATE
        // 是原子的，因此并发的第二个 poll 只会 affected=0，天然互斥。
        // LIMIT 不能直接跟在 UPDATE 后（SQLite 默认未编译该扩展），故走 id IN (子查询)。
        $claimToken = (string) Str::uuid();
        $affected = DB::update(
            "UPDATE relay_commands
                SET status = 'dispatched',
                    dispatched_at = ?,
                    attempts = attempts + 1,
                    claim_token = ?,
                    updated_at = ?
              WHERE id IN (
                    SELECT id FROM relay_commands
                     WHERE device_sn = ?
                       AND status = 'pending'
                       AND attempts < ?
                       AND (expires_at IS NULL OR expires_at > ?)
                     ORDER BY created_at
                     LIMIT 5)",
            [
                now(),
                $claimToken,
                now(),
                $deviceSn,
                RelayCommand::MAX_ATTEMPTS,
                now(),
            ],
        );

        $out = [];
        if ($affected > 0) {
            $cmds = RelayCommand::where('claim_token', $claimToken)
                ->orderBy('created_at')
                ->get();
            foreach ($cmds as $c) {
                $out[] = ['id' => $c->id, 'command' => $c->command, 'payload' => $c->payload];
            }
        }

        return ApiResponder::success('commands', ['commands' => $out]);
    }

    /** 中继回传执行结果（RelayAuth）。 */
    public function result(Request $request, int $id): JsonResponse
    {
        $raw = $request->getContent();
        $authError = RelayAuth::verify($raw, $request->bearerToken(), $request->header('X-Relay-Sig'));
        if ($authError !== null) {
            return ApiResponder::error($authError, 401);
        }

        $request->validate([
            'status'  => ['required', 'string', 'in:done,failed'],
            'result'  => ['nullable', 'array'],
            'error'   => ['nullable', 'string', 'max:255'],
        ]);

        $cmd = RelayCommand::find($id);
        if ($cmd === null) {
            return ApiResponder::error(
                new ErrorObject('not_found', 'command_not_found', 'Command no longer exists'),
                404,
            );
        }

        $cmd->status = (string) ($request->input('status') ?? 'done');
        $cmd->result = $request->input('result');
        $cmd->error = $request->input('error');
        $cmd->executed_at = now();
        $cmd->save();

        return ApiResponder::success('command', $this->toArray($cmd));
    }

    /**
     * 中继上传拍照结果（multipart，仅验 bearer token）。
     *
     * 写入 public/relay-photos/{device_sn}/ 下，返回可访问 URL。若带 command_id
     * 则顺带把命令标记为 done 并回写照片 URL 到 result。
     */
    public function uploadPhoto(Request $request): JsonResponse
    {
        // multipart 难做 HMAC，仅验证 bearer token（见类文档说明）。
        if (! RelayAuth::acceptsBearer($request->bearerToken())) {
            return ApiResponder::error(
                new ErrorObject('authentication_error', 'invalid_relay_token', 'BMS relay token missing or incorrect'),
                401,
            );
        }

        $deviceSn = (string) $request->input('device_sn', '');
        $commandId = (int) $request->input('command_id', 0);
        // device_sn becomes a PATH SEGMENT below — a "../.." value would write
        // outside relay-photos/. Whitelist it like an identifier.
        if ($deviceSn === '' || strlen($deviceSn) > 32 || ! preg_match('/^[A-Za-z0-9_-]+$/', $deviceSn)) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'invalid_envelope', 'device_sn required'),
                422,
            );
        }

        $file = $request->file('photo');
        if ($file === null || ! $file->isValid()) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'no_file', 'photo file required'),
                422,
            );
        }

        // Strict content validation — this endpoint writes into public/, served
        // from the same origin as the dashboard. An unrestricted upload could
        // drop an .html/.svg there and become stored XSS under the session's
        // own cookie jar. Only real JPEG/PNG bytes may pass, and the stored
        // extension is FORCED from the server-detected MIME (never the
        // client-supplied filename).
        if ($file->getSize() > 10 * 1024 * 1024) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'file_too_large', 'photo exceeds 10 MB'),
                413,
            );
        }
        $ext = match ($file->getMimeType()) {
            'image/jpeg' => 'jpg',
            'image/png'  => 'png',
            default      => null,
        };
        if ($ext === null) {
            return ApiResponder::error(
                new ErrorObject('invalid_request_error', 'not_an_image', 'photo must be a JPEG or PNG image'),
                422,
            );
        }

        $dir = public_path("relay-photos/{$deviceSn}");
        if (! is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        $name = ($commandId ?: 'manual') . '.' . $ext;
        $file->move($dir, $name);

        // 存相对 path：手机端用 apiBaseUrl 拼 origin（rewriteToBase 已兼容），
        // 不再写死 APP_URL（= http://127.0.0.1:8000，手机永远打不开，A-30）。
        $url = "/relay-photos/{$deviceSn}/{$name}";

        if ($commandId) {
            // 归属校验：照片只能挂到「本中继自己」的命令上，防止持 token 者
            // 把图贴到别的设备的 command_id（A-3）。device_sn 即 multipart 中
            // 已白名单校验过的本机身份。
            $cmd = RelayCommand::where('id', $commandId)
                ->where('device_sn', $deviceSn)
                ->first();
            if ($cmd === null) {
                return ApiResponder::error(
                    new ErrorObject('not_found', 'command_not_found', 'Command does not belong to this relay'),
                    404,
                );
            }
            $cmd->result = array_merge($cmd->result ?? [], ['photo_url' => $url]);
            $cmd->status = 'done';
            $cmd->executed_at = now();
            $cmd->save();
        }

        return ApiResponder::success('photo', ['url' => $url]);
    }

    /** 仪表盘查看某设备指令历史。 */
    public function listForDashboard(Request $request): JsonResponse
    {
        $deviceSn = (string) $request->query('device_sn', '');
        $cmds = RelayCommand::where('device_sn', $deviceSn)
            ->orderByDesc('created_at')
            ->limit(20)
            ->get();

        return ApiResponder::success('commands', [
            'commands' => array_map(fn (RelayCommand $c) => $this->toArray($c), $cmds->all()),
        ]);
    }

    /** @return array<string, mixed> */
    private function toArray(RelayCommand $c): array
    {
        return [
            'id'             => $c->id,
            'device_sn'      => $c->device_sn,
            'command'        => $c->command,
            'payload'        => $c->payload,
            'status'         => $c->status,
            'attempts'       => $c->attempts,
            'result'         => $c->result,
            'error'          => $c->error,
            'issued_by'      => $c->issued_by,
            'created_at'     => $c->created_at?->toIso8601String(),
            'dispatched_at'  => $c->dispatched_at?->toIso8601String(),
            'executed_at'    => $c->executed_at?->toIso8601String(),
            'expires_at'     => $c->expires_at?->toIso8601String(),
        ];
    }
}
