import * as FileSystem from 'expo-file-system';
// getContentUriAsync 在新 API（File 类）里没有对应方法，主入口的版本已标注
// 「will throw in runtime」，必须从 /legacy 子模块导入才可用且不报 deprecation。
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { NativeModules } from 'react-native';

const APK_FILENAME = 'wheelsense-update.apk';

export interface DownloadProgress {
  bytesWritten: number;
  bytesTotal: number;
  fraction: number;
}

/**
 * 下载最新仪表盘 APK 到 App 私有缓存目录（scoped storage，无需任何存储权限），
 * 再用系统安装器（ACTION_VIEW + content://）调起安装确认。全程前台、由用户点确认，
 * 无 root、无静默装、无后台装。
 *
 * 安全（安卓 16 天然保障）：
 *  - 下载链路走 HTTPS；
 *  - 只用 content://（FileProvider）绝不 file://，安装器凭 FLAG_GRANT_READ_URI_PERMISSION
 *    临时只读本次文件；
 *  - Android PackageInstaller 强制同签名：与已装 App 签名不同的包（篡改/MITM 替换）直接拒装。
 *
 * @param baseUrl 服务器地址（含 scheme+host+port，无尾斜杠）
 * @param token   info 接口下发的短时下载 token（?t= 传递，避免原生下载不带 session cookie）
 */
export async function downloadAndInstallDashboardApk(
  baseUrl: string,
  token: string,
  expectedSha256: string,
  expectedSize: number | null,
  onProgress?: (p: DownloadProgress) => void,
): Promise<{ launched: boolean }> {
  const dest = new FileSystem.File(FileSystem.Paths.cache, APK_FILENAME);
  const url = `${baseUrl}/api/dashboard/apk?t=${encodeURIComponent(token)}`;

  const file = await FileSystem.File.downloadFileAsync(url, dest, {
    headers: {},
    idempotent: true, // 缓存里已有旧文件时直接覆盖，便于重试
    onProgress: (prog) => {
      const total = prog.totalBytes;
      if (onProgress && total > 0) {
        onProgress({ bytesWritten: prog.bytesWritten, bytesTotal: total, fraction: prog.bytesWritten / total });
      }
    },
  });

  const verifier = NativeModules.WidgetDataModule;
  if (!verifier?.verifyDownloadedApk) {
    throw new Error('当前版本缺少安装包完整性校验能力');
  }
  await verifier.verifyDownloadedApk(file.uri, expectedSha256, expectedSize ?? -1);

  // file:// -> content://（Expo FileProvider），并授权安装器读取。
  const contentUri = await getContentUriAsync(file.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1, // Intent.FLAG_GRANT_READ_URI_PERMISSION
  });
  return { launched: true };
}
