package io.github.lovemygoddess.wheelsense

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Self-chaining exact-alarm scheduler for widget auto-refresh.
 *
 * The stock AppWidgetProvider updatePeriodMillis is clamped by the system to
 * 30 min minimum — too coarse for a battery dashboard. Instead, each widget
 * refresh schedules the NEXT alarm as it completes (chain), at the interval
 * the user picked in the app's settings page (1/5/10/15/30 min).
 *
 * Chain arming points: fetch completion, BOOT_COMPLETED, app foreground save,
 * interval change. If exact alarms are denied (Android 12+ "Alarms &
 * reminders" special access), degrade to inexact setAndAllowWhileIdle.
 */
object WidgetRefreshScheduler {
    private const val TAG = "WidgetRefreshSched"
    private const val REQUEST_CODE = 7741

    const val KEY_INTERVAL_MIN = "widget_refresh_min"
    const val DEFAULT_INTERVAL_MIN = 30
    private const val NOTIFICATION_INTERVAL_MIN = 5

    private fun alarmManager(context: Context): AlarmManager =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun refreshIntent(context: Context): PendingIntent {
        val intent = Intent(NinebotWidgetProvider.ACTION_REFRESH).apply {
            component = ComponentName(context, NinebotWidgetProvider::class.java)
        }
        return PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun intervalMin(context: Context): Int {
        val prefs = context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
        val v = prefs.getInt(KEY_INTERVAL_MIN, DEFAULT_INTERVAL_MIN)
        return v.coerceIn(1, 120)
    }

    fun notificationsEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(NotificationHelper.KEY_N_CHARGE_START, true) ||
            prefs.getBoolean(NotificationHelper.KEY_N_CHARGE_END, true) ||
            prefs.getBoolean(NotificationHelper.KEY_N_TEMP_HIGH, true) ||
            prefs.getBoolean(NotificationHelper.KEY_N_EZVIZ_ALARM, true) ||
            prefs.getBoolean(NotificationHelper.KEY_N_LOW_BATTERY, true)
    }

    /** Notifications should not inherit a 15/30-minute widget interval. */
    fun effectiveIntervalMin(context: Context): Int = if (notificationsEnabled(context)) {
        minOf(intervalMin(context), NOTIFICATION_INTERVAL_MIN)
    } else {
        intervalMin(context)
    }

    fun setIntervalMin(context: Context, minutes: Int) {
        val prefs = context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putInt(KEY_INTERVAL_MIN, minutes.coerceIn(1, 120)).apply()
        scheduleNext(context)
    }

    /** Schedule the next refresh one interval from now. */
    fun scheduleNext(context: Context) {
        try {
            val am = alarmManager(context)
            val effectiveMin = effectiveIntervalMin(context)
            val intervalMs = effectiveMin * 60_000L
            val triggerAt = System.currentTimeMillis() + intervalMs
            context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putLong("notify_next_check_at", triggerAt).apply()
            val pi = refreshIntent(context)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            } else {
                // No exact-alarm grant — inexact still fires, just batched by Doze.
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            }
            Log.d(TAG, "next background refresh in $effectiveMin min")
        } catch (e: Exception) {
            Log.w(TAG, "scheduleNext failed", e)
        }
    }

    fun cancel(context: Context) {
        try {
            alarmManager(context).cancel(refreshIntent(context))
        } catch (_: Exception) {}
    }
}
