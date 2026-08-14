<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\RelayAuth;
use App\Support\ApiResponder;
use App\ValueObjects\Api\ErrorObject;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * 中继 APK 自更新下载端点。
 *
 *  - 受 RelayAuth 保护（token + HMAC），与 /relay/config 同等级。
 *  - GET 请求无 body，RelayAuth::verify 用 getContent()（GET 时为 ""）做签名，
 *    因此 APK 侧下载时签名 = HMAC_SHA256("", hmacSecret)。
 *  - 文件放 storage/app/bms-relay-latest.apk（不在 web 根，避免匿名下载）。
 *    部署时由 deploy_file.py 上传该路径；新版本上线只需覆盖此文件。
 *
 * 安全说明：文件本身不可被篡改（服务器本地文件），签名只防"未授权拉取"和
 * 中间人替换——但注意 HTTPS 已提供传输加密，RelayAuth 此处主要作为"只有合法
 * 中继才能拿到更新包"的准入控制。下载到的 APK 由 Android PackageInstaller
 * 校验同签名后才安装，所以即便被中间人替换也无法静默装上去。
 */
class RelayApkController extends Controller
{
    /** 中继拉取最新 APK（RelayAuth，GET 带空 body 以便 HMAC 签名）。 */
    public function download(Request $request): BinaryFileResponse|\Illuminate\Http\JsonResponse
    {
        $raw = $request->getContent();
        $authError = RelayAuth::verify($raw, $request->bearerToken(), $request->header('X-Relay-Sig'));
        if ($authError !== null) {
            return ApiResponder::error($authError, 401);
        }

        $path = storage_path('app/bms-relay-latest.apk');
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
}
