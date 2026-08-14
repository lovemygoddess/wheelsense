package io.github.lovemygoddess.wheelsense

import android.Manifest
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

@ReactModule(name = WidgetDataModule.NAME)
class WidgetDataModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    @ReactMethod
    fun verifyDownloadedApk(uriString: String, expectedSha256: String, expectedSize: Double, promise: Promise) {
        try {
            val uri = Uri.parse(uriString)
            val file = File(requireNotNull(uri.path) { "APK path missing" })
            if (!file.isFile) throw IllegalStateException("下载的安装包不存在")
            if (expectedSize >= 0 && file.length() != expectedSize.toLong()) {
                throw SecurityException("安装包大小校验失败")
            }
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buffer = ByteArray(128 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(expectedSha256.trim(), ignoreCase = true)) {
                throw SecurityException("安装包 SHA-256 校验失败")
            }
            promise.resolve(actual)
        } catch (e: Exception) {
            promise.reject("APK_VERIFY_FAILED", e.message, e)
        }
    }

    private val prefs: SharedPreferences
        get() = reactApplicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Atomically switch the native widget data source and, when enabling Demo,
     * write the complete demo snapshot into its own namespace. This avoids a
     * JS-side sequence of independent preference writes being interleaved with
     * the widget alarm/provider process.
     */
    @ReactMethod
    fun setDemoMode(enabled: Boolean, snapshot: ReadableMap?, promise: Promise) {
        try {
            val editor = prefs.edit()
            if (enabled) {
                if (snapshot != null) {
                    val iter = snapshot.keySetIterator()
                    while (iter.hasNextKey()) {
                        val key = iter.nextKey()
                        val nativeKey = "demo_$key"
                        if (snapshot.isNull(key)) {
                            editor.remove(nativeKey)
                            continue
                        }
                        when (snapshot.getType(key)) {
                            ReadableType.String -> editor.putString(nativeKey, snapshot.getString(key))
                            ReadableType.Number -> {
                                if (isTimestampKey(nativeKey)) {
                                    editor.putLong(nativeKey, snapshot.getDouble(key).toLong())
                                } else {
                                    editor.putFloat(nativeKey, snapshot.getDouble(key).toFloat())
                                }
                            }
                            ReadableType.Boolean -> editor.putBoolean(nativeKey, snapshot.getBoolean(key))
                            else -> Unit
                        }
                    }
                }
                editor.putBoolean(KEY_DEMO_MODE, true)
                editor.putBoolean(KEY_LEGACY_DEMO_MODE, true)
            } else {
                prefs.all.keys.filter { it.startsWith("demo_") }.forEach { editor.remove(it) }
                editor.putBoolean(KEY_DEMO_MODE, false)
                editor.putBoolean(KEY_LEGACY_DEMO_MODE, false)
            }
            editor.apply()
            NinebotWidgetProvider.requestUpdate(reactApplicationContext)
            if (!enabled) NinebotWidgetProvider.requestFetch(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WIDGET_DEMO_MODE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun saveWidgetData(data: ReadableMap, promise: Promise) {
        try {
            val editor = prefs.edit()
            val iter = data.keySetIterator()
            var carriesTelemetry = false
            while (iter.hasNextKey()) {
                val key = iter.nextKey()
                if (data.isNull(key)) {
                    editor.remove(key)
                    continue
                }
                when (data.getType(key)) {
                    ReadableType.String -> editor.putString(key, data.getString(key))
                    ReadableType.Number -> {
                        // React Native exposes all JS numbers as doubles. Keep
                        // widget timestamps as Longs because the provider reads
                        // them with SharedPreferences.getLong(). This applies
                        // to both the real snapshot and the demo_* namespace.
                        if (isTimestampKey(key)) {
                            editor.putLong(key, data.getDouble(key).toLong())
                        } else {
                            editor.putFloat(key, data.getDouble(key).toFloat())
                        }
                    }
                    ReadableType.Boolean -> editor.putBoolean(key, data.getBoolean(key))
                    else -> { /* skip maps/arrays */ }
                }
                if (TELEMETRY_KEYS.contains(key)) carriesTelemetry = true
            }
            // Only stamp "fresh data" when the payload actually carries telemetry.
            // Settings writes (notify_* toggles, app_* prefs, server URL) used to
            // refresh the timestamp too — making the widget's stale check treat
            // hours-old readings as brand new.
            if (carriesTelemetry) {
                editor.putLong(KEY_UPDATED_AT, System.currentTimeMillis())
            }
            editor.apply()

            NinebotWidgetProvider.requestUpdate(reactApplicationContext)
            // Arm the auto-refresh alarm chain whenever the app is alive.
            WidgetRefreshScheduler.scheduleNext(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WIDGET_SAVE_ERROR", e.message, e)
        }
    }

    /** Set the widget auto-refresh interval in minutes (from the app settings page). */
    @ReactMethod
    fun setRefreshInterval(minutes: Int, promise: Promise) {
        try {
            WidgetRefreshScheduler.setIntervalMin(reactApplicationContext, minutes)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WIDGET_INTERVAL_ERROR", e.message, e)
        }
    }

    /** Android 13+ notification permission state (true on older versions). */
    @ReactMethod
    fun hasNotificationPermission(promise: Promise) {
        try {
            promise.resolve(NotificationHelper.hasPermission(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("NOTIF_CHECK_ERROR", e.message, e)
        }
    }

    /**
     * Whether the widget's self-refresh chain can use exact alarms
     * (`setExactAndAllowWhileIdle`, which fires on time even under Doze).
     *
     * On Android 12+ (API 31+) this requires the "Alarms & reminders"
     * special permission (SCHEDULE_EXACT_ALARM), which is OFF by default and
     * must be granted in system settings. Without it, the scheduler silently
     * degrades to `setAndAllowWhileIdle`, whose alarms get batched by Doze and
     * only fire when the device is actively used — i.e. the widget stops
     * auto-refreshing in the background.
     *
     * Below API 31 exact alarms are always allowed, so this returns true.
     */
    @ReactMethod
    fun canScheduleExactAlarm(promise: Promise) {
        try {
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val am = reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                am.canScheduleExactAlarms()
            } else {
                true
            }
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.reject("EXACT_ALARM_CHECK", e.message, e)
        }
    }

    /**
     * Open the per-app "Alarms & reminders" settings page so the user can grant
     * SCHEDULE_EXACT_ALARM. Required for reliable background widget refresh on
     * Android 12+. No-op below API 31 (permission does not exist there).
     */
    @ReactMethod
    fun openExactAlarmSettings(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                promise.resolve(true)
                return
            }
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                data = Uri.fromParts("package", reactApplicationContext.packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val act = reactApplicationContext.currentActivity
            if (act != null) act.startActivity(intent) else reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("EXACT_ALARM_OPEN", e.message, e)
        }
    }

    /**
     * Request POST_NOTIFICATIONS via RN's PermissionAwareActivity. The result
     * is delivered asynchronously — we resolve the CURRENT state immediately;
     * the settings page re-checks on focus after the system dialog closes.
     */
    @ReactMethod
    fun requestNotificationPermission(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                promise.resolve(NotificationHelper.hasPermission(reactApplicationContext))
                return
            }
            val activity = reactApplicationContext.currentActivity
            if (activity is PermissionAwareActivity) {
                if (reactApplicationContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    promise.resolve(NotificationHelper.hasPermission(reactApplicationContext))
                    return
                }
                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9917) { _, _, grantResults ->
                    val granted = grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED
                    promise.resolve(granted && NotificationHelper.hasPermission(reactApplicationContext))
                    true
                }
                return
            }
            promise.resolve(false)
        } catch (e: Exception) {
            promise.reject("NOTIF_REQ_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun openNotificationSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, reactApplicationContext.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val activity = reactApplicationContext.currentActivity
            if (activity != null) activity.startActivity(intent) else reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("NOTIF_SETTINGS_ERROR", e.message, e)
        }
    }

    /** Trigger the same authenticated fetch used by the background alarm. */
    @ReactMethod
    fun refreshWidgetNow(promise: Promise) {
        try {
            NinebotWidgetProvider.requestFetch(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WIDGET_REFRESH_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun sendTestNotification(promise: Promise) {
        try {
            promise.resolve(NotificationHelper.sendTest(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("NOTIF_TEST_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getSavedWidgetData(promise: Promise) {
        try {
            val map = Arguments.createMap()
            prefs.all.forEach { (key, value) ->
                when (value) {
                    is String -> map.putString(key, value)
                    is Float -> map.putDouble(key, value.toDouble())
                    is Int -> map.putDouble(key, value.toDouble())
                    is Boolean -> map.putBoolean(key, value)
                    is Long -> map.putDouble(key, value.toDouble())
                }
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("WIDGET_READ_ERROR", e.message, e)
        }
    }

    companion object {
        const val NAME = "WidgetDataModule"
        const val PREFS_NAME = "ninebot_widget_data"
        const val KEY_UPDATED_AT = "widget_updated_at"
        const val KEY_TELEMETRY_AT = "widget_telemetry_at"
        const val KEY_BATTERY = "widget_battery_pct"
        const val KEY_SOC_VOLTAGE = "widget_soc_voltage"
        const val KEY_SOC_SOURCE = "widget_soc_source"
        const val KEY_VOLTAGE = "widget_voltage"
        const val KEY_TEMP = "widget_temperature"
        const val KEY_RANGE = "widget_range"
        const val KEY_CHARGING = "widget_charging"
        const val KEY_VEHICLE_NAME = "widget_vehicle_name"
        const val KEY_HEALTH_SCORE = "widget_health_score"
        const val KEY_LOCKED = "widget_locked"
        const val KEY_REMAIN_CHARGE = "widget_remain_charge"
        const val KEY_CHARGE_POWER = "widget_charge_power_w"
        const val KEY_CYCLES = "widget_cycles"
        const val KEY_RANGE_CALIBRATED = "widget_range_calibrated"
        const val KEY_LOCATION_SHORT = "widget_location_short"
        const val KEY_TPMS_FRONT = "widget_tpms_front_bar"
        const val KEY_TPMS_FRONT_AT = "widget_tpms_front_at"
        const val KEY_TPMS_REAR = "widget_tpms_rear_bar"
        const val KEY_TPMS_REAR_AT = "widget_tpms_rear_at"
        const val KEY_TPMS_FRONT_TEMP = "widget_tpms_front_temp_c"
        const val KEY_TPMS_REAR_TEMP = "widget_tpms_rear_temp_c"
        // 车辆产品图 URL（服务端下发）+ 本地已缓存的那一版 URL，两者不同才重下。
        const val KEY_IMAGE_URL = "widget_image_url"
        const val KEY_IMAGE_CACHED = "widget_image_cached_url"
        // Written by the JS side (via saveWidgetData) so the widget provider
        // can fetch /api/widget/summary by itself while the app is dead.
        const val KEY_SERVER_URL = "widget_server_url"
        const val KEY_API_KEY = "widget_api_key"
        const val KEY_THEME_PACK_ID = "widget_theme_pack_id"
        const val KEY_THEME_MODE = "widget_theme_mode"
        const val KEY_RESOLVED_MODE = "widget_resolved_mode"
        const val KEY_THEME_BEHAVIOR = "widget_theme_behavior"
        const val KEY_DIALOGUE_ENABLED = "widget_dialogue_enabled"
        /** Global mode switch. Demo and real widget snapshots are separate. */
        const val KEY_DEMO_MODE = "demo_mode_enabled"
        /** Kept for migration from the first Demo Mode build. */
        const val KEY_LEGACY_DEMO_MODE = "widget_demo_mode"

        /** Keys that represent actual vehicle readings — their presence in a
         *  saveWidgetData payload is what makes the data "fresh". Everything
         *  else (settings, credentials, notify toggles) must not touch the
         *  freshness timestamp. */
        private val TELEMETRY_KEYS = setOf(
            KEY_BATTERY, KEY_SOC_VOLTAGE, KEY_VOLTAGE, KEY_TEMP, KEY_RANGE,
            KEY_CHARGING, KEY_VEHICLE_NAME, KEY_HEALTH_SCORE, KEY_LOCKED,
            KEY_REMAIN_CHARGE, KEY_CYCLES, KEY_RANGE_CALIBRATED, KEY_IMAGE_URL,
            KEY_LOCATION_SHORT, KEY_TPMS_FRONT, KEY_TPMS_REAR,
            KEY_TPMS_FRONT_TEMP, KEY_TPMS_REAR_TEMP, KEY_CHARGE_POWER,
        )

        private val TIMESTAMP_KEYS = setOf(
            KEY_UPDATED_AT, KEY_TELEMETRY_AT, KEY_TPMS_FRONT_AT, KEY_TPMS_REAR_AT,
        )

        private fun isTimestampKey(key: String): Boolean {
            return TIMESTAMP_KEYS.contains(key) || TIMESTAMP_KEYS.any { key == "demo_$it" }
        }
    }
}
