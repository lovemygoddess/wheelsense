package io.github.lovemygoddess.wheelsense

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Local event notifications driven by the widget's self-refresh chain.
 *
 * The widget provider fetches /api/widget/summary on its AlarmManager chain
 * (5-30 min, works while the app process is dead). After each successful
 * fetch we compare the NEW summary against the OLD prefs snapshot and post
 * a system notification for the events the user enabled in the app settings:
 *
 *   - charge start  (with vendor remain-charge-time estimate)
 *   - charge end    (with current SOC)
 *   - battery temp crossing above the configured warn threshold (default 40°C)
 *   - battery SOC crossing down through the configured low-battery threshold
 *   - new EZVIZ alarm (backend caches the latest one during its 5-min poll)
 *
 * First-ever fetch only RECORDS state (no notification) — otherwise a fresh
 * install would fire "charge started" / the latest historical alarm right away.
 */
object NotificationHelper {
    private const val TAG = "NotificationHelper"
    private const val CHANNEL_ID = "ninebot_events"

    // Toggle keys — written by the JS settings page via WidgetDataModule.
    const val KEY_N_CHARGE_START = "notify_charge_start"
    const val KEY_N_CHARGE_END = "notify_charge_end"
    const val KEY_N_TEMP_HIGH = "notify_temp_high"
    const val KEY_N_EZVIZ_ALARM = "notify_ezviz_alarm"
    const val KEY_N_LOW_BATTERY = "notify_low_battery"
    const val KEY_N_LOW_BATTERY_PCT = "notify_low_battery_pct"
    const val KEY_N_TEMP_WARN = "notify_temp_warn"
    const val KEY_LAST_ALARM_ID = "notify_last_alarm_id"

    const val TEMP_THRESHOLD_C = 40f
    const val LOW_BATTERY_PCT = 10f

    private const val ID_CHARGE_START = 1001
    private const val ID_CHARGE_END = 1002
    private const val ID_TEMP = 1003
    private const val ID_LOW_BATTERY = 1004

    fun hasPermission(context: Context): Boolean {
        val runtimeGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!runtimeGranted || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = nm.getNotificationChannel(CHANNEL_ID)
            if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "车辆事件", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "充电开始/结束、温度过高、监控告警"
                    }
                )
            }
        }
    }

    /**
     * Compare old prefs vs new summary and fire notifications.
     * MUST be called BEFORE the new values are applied to prefs.
     * The shared editor is used to record marker keys (e.g. last alarm id)
     * so they persist atomically with the rest of the refresh.
     */
    fun checkAndNotify(
        context: Context,
        prefs: SharedPreferences,
        editor: SharedPreferences.Editor,
        summary: JSONObject,
    ) {
        if (!hasPermission(context)) return

        val newCharging = summary.optBoolean("charging")
        val newTemp = if (summary.isNull("batt_temp")) Float.NaN else summary.optDouble("batt_temp").toFloat()
        // Use the same canonical SOC as every app page. `battery` used to be
        // NineCLI dump_energy, so a 10% alert could be evaluated against a
        // completely different percentage than the one shown to the user.
        val primary = summary.optJSONObject("primary")
        val battery = when {
            primary != null && !primary.isNull("soc_pct") -> primary.optDouble("soc_pct").toInt()
            !summary.isNull("battery") -> summary.optDouble("battery").toInt()
            else -> null
        }

        // remain_charge_time: number minutes on most firmware, but some ship
        // "HH:MM" strings (e.g. "06:50") — reuse the widget's parser.
        val rMin: Int? = NinebotWidgetProvider.parseRemainMinutes(summary.opt("remain_charge_time"))
            ?.toInt()?.takeIf { it > 0 }

        // First refresh ever → record baseline only (the caller's editor already
        // persists charging/temp etc.), never notify.
        val haveBaseline = prefs.contains(WidgetDataModule.KEY_CHARGING)
        if (!haveBaseline) return

        val oldCharging = prefs.getBoolean(WidgetDataModule.KEY_CHARGING, false)
        val oldTemp = prefs.getFloat(WidgetDataModule.KEY_TEMP, -999f)

        // 1) Charge started
        if (!oldCharging && newCharging && prefs.getBoolean(KEY_N_CHARGE_START, true)) {
            val eta = rMin?.let { if (it >= 60) "，预计约 ${it / 60} 小时 ${it % 60} 分充满" else "，预计约 $it 分钟充满" } ?: ""
            post(context, ID_CHARGE_START, "开始充电", "车辆已开始充电$eta")
        }

        // 2) Charge ended
        if (oldCharging && !newCharging && prefs.getBoolean(KEY_N_CHARGE_END, true)) {
            val soc = battery?.let { "，当前电量 $it%" } ?: ""
            post(context, ID_CHARGE_END, "充电结束", "车辆已停止充电$soc")
        }

        // 3) Battery temperature crossing above the (user-configurable) warn threshold
        val tempWarn = prefs.getFloat(KEY_N_TEMP_WARN, TEMP_THRESHOLD_C)
        if (!newTemp.isNaN() && newTemp > tempWarn && oldTemp <= tempWarn &&
            prefs.getBoolean(KEY_N_TEMP_HIGH, true)
        ) {
            post(context, ID_TEMP, "电池温度过高", "当前电池温度 ${newTemp.toInt()}°C，请注意散热")
        }

        // 4b) Battery SOC crossing DOWN through the low-battery threshold
        val lowPct = prefs.getFloat(KEY_N_LOW_BATTERY_PCT, LOW_BATTERY_PCT)
        val oldBattery = prefs.getFloat(WidgetDataModule.KEY_BATTERY, -1f)
        if (battery != null && oldBattery >= 0f && battery <= lowPct && oldBattery > lowPct &&
            prefs.getBoolean(KEY_N_LOW_BATTERY, true)
        ) {
            post(context, ID_LOW_BATTERY, "电量偏低", "当前电量 ${battery}%，请及时充电")
        }

        // 4) New EZVIZ alarm (backend caches the latest during its 5-min poll)
        val alarm = summary.optJSONObject("latest_alarm")
        val alarmId = alarm?.optString("id")?.takeIf { it.isNotEmpty() && it != "null" }
        if (alarmId != null) {
            if (!prefs.contains(KEY_LAST_ALARM_ID)) {
                // First time seeing the alarm feed — record only.
                editor.putString(KEY_LAST_ALARM_ID, alarmId)
            } else if (prefs.getString(KEY_LAST_ALARM_ID, null) != alarmId) {
                editor.putString(KEY_LAST_ALARM_ID, alarmId)
                if (prefs.getBoolean(KEY_N_EZVIZ_ALARM, true)) {
                    val title = alarm.optString("title").takeIf { it.isNotEmpty() } ?: "监控告警"
                    // Per-alarm notification id so successive alarms don't overwrite.
                    post(context, 2000 + (alarmId.hashCode() and 0xFFF), "萤石监控告警", title)
                }
            }
        }
    }

    /** Immediate end-to-end smoke test for the settings page. */
    fun sendTest(context: Context): Boolean {
        if (!hasPermission(context)) return false
        return post(context, 1099, "通知测试成功", "车辆事件通知链路工作正常")
    }

    @SuppressLint("MissingPermission") // guarded by hasPermission() in checkAndNotify
    private fun post(context: Context, id: Int, title: String, text: String): Boolean {
        try {
            ensureChannel(context)
            val launch = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pi = PendingIntent.getActivity(
                context, id, launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val n = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build()
            NotificationManagerCompat.from(context).notify(id, n)
            return true
        } catch (e: Exception) {
            Log.w(TAG, "post failed", e)
            return false
        }
    }
}
