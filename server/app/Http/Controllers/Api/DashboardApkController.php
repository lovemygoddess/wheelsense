<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * 仪表盘 APK 自更新下载端点（下载到手机 + 系统安装器提示，非静默装）。
 *
 *  - info():   挂在 dashboard.gate（session cookie），返回发布包元信息 +
 *              一个短时下载 token（10 分钟有效、可重试）。仅登录用户可见。
 *  - download():不挂 session（expo-file-system 原生下载不共享 JS cookie 罐），
 *              改用 info() 下发的短时 token（?t= 或 X-Dashboard-Apk-Token header）。
 *              token 缺失/失效 → 401。
 *
 * 安全：
 *  - 文件在 storage/app（不在 web 根），匿名无法直链下载。
 *  - 全程 HTTPS（Caddy + Let's Encrypt）传输加密。
 *  - Android PackageInstaller 强制同签名：篡改/替换的包无法装到已装 App 上。
 *  - 无 root、无静默装、无后台装，一切由用户在系统安装器中点确认。
 */
class DashboardApkController extends Controller
{
    private const TOKEN_TTL_MINUTES = 10;
    private const APK_PATH = 'app/dashboard-latest.apk';
    private const META_PATH = 'app/dashboard-latest.json';

    /** 元信息 + 短时下载 token（session 鉴权）。 */
    public function info(Request $request): JsonResponse
    {
        $meta = $this->readMeta();
        if ($meta === null) {
            return ApiResponder::success('dashboard_apk', ['exists' => false]);
        }

        $token = str_replace('-', '', \Illuminate\Support\Str::uuid()->toString());
        Cache::put("dash_apk_dl:$token", true, now()->addMinutes(self::TOKEN_TTL_MINUTES));

        return ApiResponder::success('dashboard_apk', [
            'exists' => true,
            'size' => $meta['size'] ?? null,
            'version' => $meta['version'] ?? null,
            'build' => $meta['build'] ?? null,
            'published_at' => $meta['published_at'] ?? null,
            'sha256' => $meta['sha256'] ?? null,
            'release_notes' => $meta['release_notes'] ?? null,
            'download_token' => $token,
        ]);
    }

    /** 二进制下载（短时 token 鉴权）。 */
    public function download(Request $request): BinaryFileResponse|\Illuminate\Http\JsonResponse
    {
        $token = $request->query('t') ?: $request->header('X-Dashboard-Apk-Token');
        if (! is_string($token) || $token === '' || ! Cache::has("dash_apk_dl:$token")) {
            return ApiResponder::error(
                new ErrorObject('authentication_error', 'invalid_apk_token', 'Missing or expired download token'),
                401,
            );
        }

        $path = storage_path(self::APK_PATH);
        if (! is_file($path)) {
            return ApiResponder::error(
                new ErrorObject('not_found', 'apk_not_found', 'No dashboard APK published yet'),
                404,
            );
        }

        return Response::download($path, 'wheelsense-update.apk', [
            'Content-Type' => 'application/vnd.android.package-archive',
            'Cache-Control' => 'no-store, no-cache, must-revalidate',
        ]);
    }

    /**
     * 读取发布包元信息。APK 不存在返回 null；存在时 size/published_at 由文件本身
     * 推导（更准确），version/build 取自同目录的 dashboard-latest.json（部署脚本写）。
     *
     * @return array{size:int,version?:string,build?:int,published_at:string}|null
     */
    private function readMeta(): ?array
    {
        $apk = storage_path(self::APK_PATH);
        if (! is_file($apk)) {
            return null;
        }

        $meta = [];
        $metaPath = storage_path(self::META_PATH);
        if (is_file($metaPath)) {
            $decoded = json_decode((string) file_get_contents($metaPath), true);
            if (is_array($decoded)) {
                $meta = $decoded;
            }
        }

        $meta['size'] = filesize($apk);
        $meta['published_at'] = date('c', filemtime($apk));

        return $meta;
    }
}
