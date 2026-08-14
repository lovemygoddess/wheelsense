package io.github.lovemygoddess.wheelsense.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        // 开机自启：BOOT_COMPLETED。
        // 应用被覆盖安装/更新后自启：MY_PACKAGE_REPLACED —— 用户走「更新中继固件」
        // 装完新版后，系统会发这个广播，这里把中继服务重新拉起，免去「手动打开
        // 再点启动」。两者都在 Android 12+ 后台启动 FGS 的豁免名单里，不会被拦截。
        if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            // ContextCompat falls back to startService on pre-Oreo (API < 26),
            // where startForegroundService doesn't exist. Android 15 还会拒绝从
            // BOOT_COMPLETED 拉起某些 FGS 类型 —— 记录而非让整个进程崩掉。
            try {
                ContextCompat.startForegroundService(context, Intent(context, BmsRelayService::class.java))
            } catch (e: Exception) {
                Log.e("BootReceiver", "FGS start from $action rejected", e)
            }
        }
    }
}
