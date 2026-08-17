<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\RelayAuth;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * 中继 APK 自更新下载端点。
 *
 *  - 受 RelayAuth 保护（token + HMAC），与 /relay/config 同等级。
 *  - GET 请求无 body，RelayAuth::verify 用 getContent()（GET 时为 ""）做签名，
 *    因此 APK 侧下载时签名 = HMAC_SHA256("", hmacSecret)。
 *  - 文件放 storage/app/bms-relay-latest.apk（不在 web 根，避免匿名下载）。
 *    Dashboard-only info() additionally reads the optional
 *    storage/app/bms-relay-latest.json sidecar for version metadata.
 *
 * 安全说明：文件本身不可被篡改（服务器本地文件），签名只防"未授权拉取"和
 * 中间人替换——但注意 HTTPS 已提供传输加密，RelayAuth 此处主要作为"只有合法
 * 中继才能拿到更新包"的准入控制。下载到的 APK 由 Android PackageInstaller
 * 校验同签名后才安装，所以即便被中间人替换也无法静默装上去。
 */
class RelayApkController extends Controller
{
    private const APK_PATH = 'app/bms-relay-latest.apk';
    private const META_PATH = 'app/bms-relay-latest.json';

    /** Dashboard-only latest Relay release metadata (never the device version). */
    public function info(Request $request): JsonResponse
    {
        $meta = $this->readMeta();
        if ($meta === null) {
            return ApiResponder::success('relay_apk', [
                'exists' => false,
                'latest_version_name' => null,
                'latest_version_code' => null,
                'published_at' => null,
                'sha256' => null,
                'release_notes' => null,
            ]);
        }

        return ApiResponder::success('relay_apk', [
            'exists' => true,
            'latest_version_name' => $meta['version_name'] ?? null,
            'latest_version_code' => isset($meta['version_code']) ? (int) $meta['version_code'] : null,
            'size' => $meta['size'] ?? null,
            'published_at' => $meta['published_at'] ?? null,
            'sha256' => $meta['sha256'] ?? null,
            'release_notes' => $meta['release_notes'] ?? null,
        ]);
    }

    /** 中继拉取最新 APK（RelayAuth，GET 带空 body 以便 HMAC 签名）。 */
    public function download(Request $request): BinaryFileResponse|\Illuminate\Http\JsonResponse
    {
        $raw = $request->getContent();
        $authError = RelayAuth::verify($raw, $request->bearerToken(), $request->header('X-Relay-Sig'));
        if ($authError !== null) {
            return ApiResponder::error($authError, 401);
        }

        $path = storage_path(self::APK_PATH);
        if (! is_file($path)) {
            return ApiResponder::error(
                new ErrorObject('not_found', 'apk_not_found', 'No relay APK published yet'),
                404,
            );
        }

        return Response::download($path, 'bms-relay-latest.apk', [
            'Content-Type' => 'application/vnd.android.package-archive',
            'Cache-Control' => 'no-store, no-cache, must-revalidate',
        ]);
    }

    /**
     * Read the sidecar metadata when available, then apply the checked-in
     * release fallback. File facts are always derived from the APK itself.
     *
     * @return array<string, mixed>|null
     */
    private function readMeta(): ?array
    {
        $apk = storage_path(self::APK_PATH);
        if (! is_file($apk)) {
            return null;
        }

        $meta = (array) config('relay.latest', []);
        $metaPath = storage_path(self::META_PATH);
        if (is_file($metaPath)) {
            $decoded = json_decode((string) file_get_contents($metaPath), true);
            if (is_array($decoded)) {
                $meta = array_replace($meta, $decoded);
            }
        }

        // Accept the naming used by both the Relay publish notes and the
        // Dashboard APK metadata writer, while exposing one stable API shape.
        $meta['version_name'] = $meta['version_name']
            ?? $meta['versionName']
            ?? $meta['version']
            ?? null;
        $meta['version_code'] = $meta['version_code']
            ?? $meta['versionCode']
            ?? $meta['build']
            ?? null;

        $meta['size'] = filesize($apk);
        $meta['published_at'] = date('c', filemtime($apk));
        $meta['sha256'] = hash_file('sha256', $apk) ?: null;
        return $meta;
    }
}
