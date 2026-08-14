package io.github.lovemygoddess.wheelsense

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.text.format.DateUtils
import android.util.Log
import android.widget.RemoteViews
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class NinebotWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        // goAsync() may be called AT MOST ONCE per broadcast. Calling it inside
        // the per-widget loop threw IllegalStateException for every widget after
        // the first — the exception was caught per-iteration, so widget #2+
        // silently only ever re-rendered stale cache and never fetched.
        for (widgetId in appWidgetIds) {
            try {
                // 1) Render whatever is cached right now (never leave a blank widget).
                updateWidget(context, appWidgetManager, widgetId)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to update widget $widgetId", e)
            }
        }
        // 2) ONE fetch for all widgets — data lives in shared prefs anyway, so a
        //    single server round-trip refreshes every placed widget.
        try {
            fetchAndRefresh(context.applicationContext, appWidgetManager, appWidgetIds, goAsync())
        } catch (e: Exception) {
            Log.e(TAG, "widget fetch dispatch failed", e)
        }
    }

    /** 尺寸变了（换屏幕/换网格）就重画一张对应像素的位图。 */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle
    ) {
        super.onAppWidgetOptionsChanged(context, appWidgetManager, appWidgetId, newOptions)
        try {
            updateWidget(context, appWidgetManager, appWidgetId)
        } catch (e: Exception) {
            Log.e(TAG, "options change render failed", e)
        }
    }

    /** 最后一个小组件被移除时停掉自链接闹钟，否则闹钟链会一直空转耗电。 */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Notifications use the same fetch chain but must keep working when
        // the user removes the visual widget from the launcher.
        if (WidgetRefreshScheduler.notificationsEnabled(context)) {
            WidgetRefreshScheduler.scheduleNext(context)
        } else {
            WidgetRefreshScheduler.cancel(context)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // 系统深浅主题切换：立刻按新主题重绘所有已放置的小组件，
        // 否则要等到下一次定时刷新才变色，体验像"坏掉了"。
        if (intent.action == Intent.ACTION_CONFIGURATION_CHANGED) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, NinebotWidgetProvider::class.java)
            )
            for (id in ids) {
                try { updateWidget(context, manager, id) } catch (e: Exception) {
                    Log.e(TAG, "theme-change re-render failed for $id", e)
                }
            }
            return
        }
        if (intent.action == ACTION_REFRESH) {
            // Manual tap or alarm-chain tick — do a full fetch, not just a re-render.
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, NinebotWidgetProvider::class.java)
            )
            for (id in ids) {
                try {
                    updateWidget(context, manager, id) // stale render first, never blank
                } catch (e: Exception) {
                    Log.e(TAG, "ACTION_REFRESH render failed for widget $id", e)
                }
            }
            // Same single-goAsync rule as onUpdate: one fetch refreshes all.
            try {
                fetchAndRefresh(context.applicationContext, manager, ids, goAsync())
            } catch (e: Exception) {
                Log.e(TAG, "ACTION_REFRESH fetch dispatch failed", e)
            }
        }
    }

    /** GET {base}/api/widget/summary with the widget bearer token; write into
     *  the same SharedPreferences the JS side uses, then re-render ALL widgets. */
    private fun fetchAndRefresh(
        context: Context,
        manager: AppWidgetManager,
        widgetIds: IntArray,
        pendingResult: BroadcastReceiver.PendingResult
    ) {
        fetchExecutor.execute {
            try {
                val prefs = context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
                prefs.edit().putLong("notify_last_attempt_at", System.currentTimeMillis()).apply()
                // Demo Mode owns the widget cache while enabled. Never let
                // the background worker contact the user's real server.
                if (isDemoModeEnabled(prefs)) return@execute
                val base = prefs.getString(WidgetDataModule.KEY_SERVER_URL, null)?.trim()?.trimEnd('/')
                val token = prefs.getString(WidgetDataModule.KEY_API_KEY, null)?.trim()
                if (base.isNullOrEmpty() || token.isNullOrEmpty()) return@execute

                val conn = (URL("$base/api/widget/summary").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("Accept", "application/json")
                }
                var imageUrl: String? = null
                try {
                    if (conn.responseCode != 200) {
                        Log.w(TAG, "widget summary HTTP ${conn.responseCode}")
                        return@execute
                    }
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    val summary = JSONObject(body).optJSONObject("summary") ?: return@execute
                    val e = prefs.edit()
                    // Event notifications compare OLD prefs against the NEW summary,
                    // so they must run before e.apply() overwrites the snapshot.
                    try {
                        NotificationHelper.checkAndNotify(context, prefs, e, summary)
                    } catch (npe: Exception) {
                        Log.w(TAG, "notify check failed", npe)
                    }
                    fun optF(key: String, jsonKey: String) {
                        if (!summary.isNull(jsonKey)) e.putFloat(key, summary.optDouble(jsonKey).toFloat())
                    }
                    optF(WidgetDataModule.KEY_BATTERY, "battery")
                    // `primary` is the server's one canonical SOC/range pair.
                    // Do not separately choose a board/voltage/vendor value in
                    // the widget: that was why it could disagree with the app.
                    val primary = summary.optJSONObject("primary")
                    if (primary != null) {
                        if (!primary.isNull("soc_pct")) {
                            e.putFloat(WidgetDataModule.KEY_SOC_VOLTAGE, primary.optDouble("soc_pct").toFloat())
                        } else {
                            e.remove(WidgetDataModule.KEY_SOC_VOLTAGE)
                        }
                        val source = primary.optString("source", "")
                        if (source.isNotEmpty()) e.putString(WidgetDataModule.KEY_SOC_SOURCE, source)
                        else e.remove(WidgetDataModule.KEY_SOC_SOURCE)
                        if (!primary.isNull("age_seconds")) {
                            val ageMs = primary.optLong("age_seconds", 0L).coerceAtLeast(0L) * 1000L
                            e.putLong(WidgetDataModule.KEY_TELEMETRY_AT, System.currentTimeMillis() - ageMs)
                        }
                        if (!primary.isNull("range_km")) {
                            e.putFloat(WidgetDataModule.KEY_RANGE_CALIBRATED, primary.optDouble("range_km").toFloat())
                        } else {
                            e.remove(WidgetDataModule.KEY_RANGE_CALIBRATED)
                        }
                    } else {
                        // Compatibility with an older server during a rolling
                        // deployment; new releases always take the branch above.
                        optF(WidgetDataModule.KEY_SOC_VOLTAGE, "soc_voltage_pct")
                        val source = summary.optString("soc_source", "")
                        if (source.isNotEmpty()) e.putString(WidgetDataModule.KEY_SOC_SOURCE, source)
                    }
                    optF(WidgetDataModule.KEY_VOLTAGE, "bms_voltage")
                    optF(WidgetDataModule.KEY_TEMP, "batt_temp")
                    optF(WidgetDataModule.KEY_RANGE, "endurance")
                    if (primary == null) optF(WidgetDataModule.KEY_RANGE_CALIBRATED, "calibrated_endurance_km")
                    // 循环次数必须用 effective_cycle_count（基线+能量法，≈169）；
                    // bms_cycles 是车机假值（bms_cycle_support=false 时恒为 9）。
                    if (!summary.isNull("effective_cycle_count")) {
                        e.putFloat(WidgetDataModule.KEY_CYCLES, summary.optDouble("effective_cycle_count").toFloat())
                    } else {
                        optF(WidgetDataModule.KEY_CYCLES, "bms_cycles")
                    }
                    optF(WidgetDataModule.KEY_HEALTH_SCORE, "bms_score")
                    optF(WidgetDataModule.KEY_LOCKED, "lock")
                    e.putBoolean(WidgetDataModule.KEY_CHARGING, summary.optBoolean("charging"))
                    val name = summary.optString("vehicle_name", "")
                    if (name.isNotEmpty()) e.putString(WidgetDataModule.KEY_VEHICLE_NAME, name)
                    val location = summary.optString("location_short", "")
                    if (location.isNotEmpty()) e.putString(WidgetDataModule.KEY_LOCATION_SHORT, location)
                    else e.remove(WidgetDataModule.KEY_LOCATION_SHORT)

                    // Replace, never merge, wheel readings. Otherwise a null
                    // response after the fifteen-minute window would leave the
                    // previous pressure cached and visible indefinitely.
                    e.remove(WidgetDataModule.KEY_TPMS_FRONT)
                    e.remove(WidgetDataModule.KEY_TPMS_FRONT_AT)
                    e.remove(WidgetDataModule.KEY_TPMS_FRONT_TEMP)
                    e.remove(WidgetDataModule.KEY_TPMS_REAR)
                    e.remove(WidgetDataModule.KEY_TPMS_REAR_AT)
                    e.remove(WidgetDataModule.KEY_TPMS_REAR_TEMP)
                    val tpms = summary.optJSONObject("tpms")
                    // 胎压/胎温同帧解码：15 分钟内（含）才缓存；胎温缺则清掉旧值。
                    fun cacheWheel(jsonKey: String, valueKey: String, timeKey: String, tempKey: String) {
                        val wheel = tpms?.optJSONObject(jsonKey) ?: return
                        if (wheel.isNull("pressure_bar") || wheel.isNull("age_seconds")) return
                        val ageSeconds = wheel.optLong("age_seconds", Long.MAX_VALUE)
                        if (ageSeconds !in 0L..900L) return
                        e.putFloat(valueKey, wheel.optDouble("pressure_bar").toFloat())
                        e.putLong(timeKey, System.currentTimeMillis() - ageSeconds * 1000L)
                        if (!wheel.isNull("temp_c")) {
                            e.putFloat(tempKey, wheel.optDouble("temp_c").toFloat())
                        } else {
                            e.remove(tempKey)
                        }
                    }
                    cacheWheel("front", WidgetDataModule.KEY_TPMS_FRONT, WidgetDataModule.KEY_TPMS_FRONT_AT, WidgetDataModule.KEY_TPMS_FRONT_TEMP)
                    cacheWheel("rear", WidgetDataModule.KEY_TPMS_REAR, WidgetDataModule.KEY_TPMS_REAR_AT, WidgetDataModule.KEY_TPMS_REAR_TEMP)
                    // 车辆产品图 URL（官方透明底 PNG）；实际下载在下面做，
                    // 只有 URL 变了才会真的联网。
                    val img = summary.optString("image_url", "")
                    if (img.isNotEmpty()) {
                        imageUrl = img
                        e.putString(WidgetDataModule.KEY_IMAGE_URL, img)
                    }
                    // remain_charge_time: number minutes on most firmware,
                    // but some ship "HH:MM" strings (e.g. "06:50") or null.
                    val rMin = parseRemainMinutes(summary.opt("remain_charge_time"))
                    if (rMin != null && rMin > 0f) {
                        e.putFloat(WidgetDataModule.KEY_REMAIN_CHARGE, rMin)
                    } else {
                        e.remove(WidgetDataModule.KEY_REMAIN_CHARGE)
                    }
                    // 充电实时功率（瓦）：仅充电中且中继新鲜时服务端才给值；
                    // 否则为 null，清掉旧值，避免停充后还显示陈旧功率。
                    if (!summary.isNull("charge_power_w")) {
                        e.putFloat(WidgetDataModule.KEY_CHARGE_POWER, summary.optDouble("charge_power_w").toFloat())
                    } else {
                        e.remove(WidgetDataModule.KEY_CHARGE_POWER)
                    }
                    e.putLong(WidgetDataModule.KEY_UPDATED_AT, System.currentTimeMillis())
                    e.putLong("notify_last_success_at", System.currentTimeMillis())
                    e.remove("notify_last_error")
                    e.apply()
                } finally {
                    conn.disconnect()
                }
                // 仍在后台线程：URL 变了才下载/裁剪/缩放，之后一直吃本地缓存。
                try {
                    VehicleImageCache.ensure(
                        context,
                        imageUrl ?: prefs.getString(WidgetDataModule.KEY_IMAGE_URL, null),
                        prefs
                    )
                } catch (ie: Exception) {
                    Log.w(TAG, "vehicle image ensure failed", ie)
                }
            } catch (e: Exception) {
                Log.w(TAG, "widget fetch failed (rendering stale)", e)
                context.getSharedPreferences(WidgetDataModule.PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString("notify_last_error", e.javaClass.simpleName).apply()
            } finally {
                for (id in widgetIds) {
                    try { updateWidget(context, manager, id) } catch (_: Exception) {}
                }
                // Chain the next auto-refresh (interval from user setting).
                try { WidgetRefreshScheduler.scheduleNext(context) } catch (_: Exception) {}
                pendingResult.finish()
            }
        }
    }

    companion object {
        private const val TAG = "NinebotWidget"
        const val ACTION_REFRESH = "io.github.lovemygoddess.wheelsense.WIDGET_REFRESH"

        private val fetchExecutor = Executors.newSingleThreadExecutor()

        fun isDemoModeEnabled(prefs: android.content.SharedPreferences): Boolean =
            prefs.getBoolean(WidgetDataModule.KEY_DEMO_MODE, false) ||
                prefs.getBoolean(WidgetDataModule.KEY_LEGACY_DEMO_MODE, false)

        /** 渲染位图的宽度上限（px）；再大对观感无益，只是白烧内存。 */
        private const val MAX_RENDER_W = 1000f

        /** Minutes from number / "120" / "HH:MM" forms; null when absent. */
        fun parseRemainMinutes(v: Any?): Float? = when (v) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
                ?: v.split(":").let { p ->
                    if (p.size == 2) {
                        val h = p[0].toIntOrNull(); val m = p[1].toIntOrNull()
                        if (h != null && m != null) (h * 60 + m).toFloat() else null
                    } else null
                }
            else -> null
        }

        private fun parseColor(value: String?, fallback: Int): Int {
            if (value.isNullOrBlank()) return fallback
            return try { android.graphics.Color.parseColor(value) } catch (_: Exception) { fallback }
        }

        /** Missing/corrupt theme fields degrade to the default-tech palette. */
        private fun readWidgetSkin(prefs: android.content.SharedPreferences, prefix: String): WidgetRenderer.Skin {
            val dark = prefix.endsWith("dark")
            fun c(key: String, light: Int, night: Int) = parseColor(prefs.getString("${prefix}_$key", null), if (dark) night else light)
            return WidgetRenderer.Skin(
                primary = c("primary", 0xFF7657F6.toInt(), 0xFF9B82FF.toInt()),
                primarySoft = c("primary_soft", 0xFFECE8FF.toInt(), 0xFF28203F.toInt()),
                background = c("background", 0xFFF5F6F8.toInt(), 0xFF0C0A10.toInt()),
                surface = c("surface", 0xFFFFFFFF.toInt(), 0xFF15121B.toInt()),
                surfaceSecondary = c("surface_secondary", 0xFFF0F1F5.toInt(), 0xFF1B1723.toInt()),
                border = c("border", 0xFFE4E5EA.toInt(), 0xFF292431.toInt()),
                textPrimary = c("text_primary", 0xFF17151D.toInt(), 0xFFF7F5FA.toInt()),
                textSecondary = c("text_secondary", 0xFF5E5A68.toInt(), 0xFFC8C2D0.toInt()),
                textMuted = c("text_muted", 0xFF777280.toInt(), 0xFF928B9B.toInt()),
                warning = c("warning", 0xFFF59E0B.toInt(), 0xFFFBBF24.toInt()),
                danger = c("danger", 0xFFEF4444.toInt(), 0xFFFB7185.toInt()),
                glowOpacity = prefs.getFloat("widget_glow_opacity", 0.12f).coerceIn(0f, 0.22f),
            )
        }

        fun requestUpdate(context: Context) {
            try {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(
                    ComponentName(context, NinebotWidgetProvider::class.java)
                )
                if (ids.isEmpty()) return
                for (id in ids) {
                    updateWidget(context, manager, id)
                }
            } catch (e: Exception) {
                Log.e(TAG, "requestUpdate failed", e)
            }
        }

        /** Fetch now even when no launcher widget is currently placed. */
        fun requestFetch(context: Context) {
            val intent = Intent(ACTION_REFRESH).apply {
                component = ComponentName(context, NinebotWidgetProvider::class.java)
            }
            context.sendBroadcast(intent)
        }

        fun updateWidget(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val prefs = context.getSharedPreferences(
                WidgetDataModule.PREFS_NAME,
                Context.MODE_PRIVATE
            )
            val views = RemoteViews(context.packageName, R.layout.widget_ninebot)
            val isDemo = isDemoModeEnabled(prefs)
            fun snapshotKey(key: String): String = if (isDemo) "demo_$key" else key

            // Older Demo builds sent JS timestamps through the generic map
            // writer, which persisted them as Float. Read both representations
            // so an upgrade can render the Demo snapshot immediately instead
            // of failing the whole render and leaving the launcher's previous
            // real-data RemoteViews on screen.
            fun readLongCompat(key: String, default: Long = 0L): Long {
                return try {
                    prefs.getLong(key, default)
                } catch (_: ClassCastException) {
                    try { prefs.getFloat(key, default.toFloat()).toLong() } catch (_: Exception) { default }
                }
            }

            // ---------------------------------------------------------- 取数
            // SOC：与首页统一——大字号一律走电压法（蜂巢 14S 高压 OCV 表），
            // 车机 vendor 数（系统性偏高约 15pp）仅作对照、不替换主显示。
            // 充电中电压被 I×R 略抬（<1pp），远小于 vendor 的 +15pp，
            // 故充放电都走电压法，口径与首页完全一致。
            val vendorSoc = prefs.getFloat(snapshotKey(WidgetDataModule.KEY_BATTERY), -1f)
            val socVoltage = prefs.getFloat(snapshotKey(WidgetDataModule.KEY_SOC_VOLTAGE), -1f)
            val charging = prefs.getBoolean(snapshotKey(WidgetDataModule.KEY_CHARGING), false)
            val socShown = if (socVoltage >= 0f) socVoltage else vendorSoc
            // 续航优先自学习校准值：车机预估按原厂电池标定，第三方包下会飘到
            // 227km（实测 ~46km），完全不能看。
            val rangeCalibrated = prefs.getFloat(snapshotKey(WidgetDataModule.KEY_RANGE_CALIBRATED), -1f)
            // 续航兜底改显 "--"：vendor 预估按原厂电池标定，第三方包下可偏到 5×
            // （227 vs 实测 46km），显示它不如不显示 —— 与 App 端"厂商估算仅对照"口径对齐。
            val rangeShown = if (rangeCalibrated >= 0f) rangeCalibrated else -1f
            // 标签保持短（"剩余里程"），中间栏宽度有限，加"·校准"会顶到车辆图。
            val updatedAt = readLongCompat(snapshotKey(WidgetDataModule.KEY_UPDATED_AT))
            val telemetryAt = readLongCompat(snapshotKey(WidgetDataModule.KEY_TELEMETRY_AT), updatedAt)
            // 数据过期判定：最近成功拉取距今超过 max(2×刷新间隔, 12min) → 视为
            // 离线/断流，渲染时灰化，避免旧数据一直以"正常"面貌显示。
            val staleMs = max(2L * WidgetRefreshScheduler.intervalMin(context) * 60_000L, 12 * 60_000L)
            val isStale = telemetryAt <= 0L || (System.currentTimeMillis() - telemetryAt) > staleMs
            val vehicleName = prefs.getString(snapshotKey(WidgetDataModule.KEY_VEHICLE_NAME), null)
                ?.takeIf { it.isNotBlank() } ?: context.getString(R.string.app_name)
            val locationShort = prefs.getString(snapshotKey(WidgetDataModule.KEY_LOCATION_SHORT), null)
            val now = System.currentTimeMillis()
            // 15 分钟内（含）的胎压/胎温才显示；时间键未写入或超龄即视为无数据。
            fun freshReading(valueKey: String, timeKey: String, minValid: Float): Float? {
                val capturedAt = readLongCompat(timeKey)
                if (capturedAt <= 0L) return null
                val age = now - capturedAt
                if (age < 0L || age > 900_000L) return null
                val v = prefs.getFloat(valueKey, Float.NaN)
                return v.takeIf { !v.isNaN() && v >= minValid }
            }
            val frontPressure = freshReading(snapshotKey(WidgetDataModule.KEY_TPMS_FRONT), snapshotKey(WidgetDataModule.KEY_TPMS_FRONT_AT), 0f)
            val rearPressure = freshReading(snapshotKey(WidgetDataModule.KEY_TPMS_REAR), snapshotKey(WidgetDataModule.KEY_TPMS_REAR_AT), 0f)
            // 胎温可低至零下，下限仅作合理性兜底（-90℃）。
            val frontTemp = freshReading(snapshotKey(WidgetDataModule.KEY_TPMS_FRONT_TEMP), snapshotKey(WidgetDataModule.KEY_TPMS_FRONT_AT), -90f)
            val rearTemp = freshReading(snapshotKey(WidgetDataModule.KEY_TPMS_REAR_TEMP), snapshotKey(WidgetDataModule.KEY_TPMS_REAR_AT), -90f)
            // 充电实时功率 / 剩余充电时间：键被服务端清掉（返回 -1f）即不显示。
            val chargePowerW = prefs.getFloat(snapshotKey(WidgetDataModule.KEY_CHARGE_POWER), -1f)
                .takeIf { it >= 0f }
            val remainChargeMin = prefs.getFloat(snapshotKey(WidgetDataModule.KEY_REMAIN_CHARGE), -1f)
                .takeIf { it > 0f }

            // 绝对时间而非相对时间：相对时间在渲染时快照，两次刷新间隔内会一直
            // 显示"刚刚"，伪装成新鲜数据。绝对 HH:mm 不会说谎；非今天再补日期。
            val updatedText = if (telemetryAt > 0L) {
                val fmt = if (DateUtils.isToday(telemetryAt)) "HH:mm" else "MM-dd HH:mm"
                context.getString(R.string.widget_updated_prefix) +
                    android.text.format.DateFormat.format(fmt, telemetryAt)
            } else context.getString(R.string.widget_no_data)

            // ------------------------------------------------------ 尺寸 & 渲染
            try {
                val density = context.resources.displayMetrics.density
                // Theme Bridge: choose App-resolved or Android system mode.
                val systemNight = (context.resources.configuration.uiMode
                    and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
                val behavior = prefs.getString(WidgetDataModule.KEY_THEME_BEHAVIOR, "app") ?: "app"
                val appResolved = prefs.getString(WidgetDataModule.KEY_RESOLVED_MODE, "light") == "dark"
                val isNight = if (behavior == "system") systemNight else appResolved
                val theme = if (isNight) WidgetRenderer.Theme.DARK else WidgetRenderer.Theme.LIGHT
                val skin = readWidgetSkin(prefs, if (isNight) "widget_dark" else "widget_light")
                val opts = try { manager.getAppWidgetOptions(widgetId) } catch (e: Exception) { null }
                var wDp = opts?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
                var hDp = opts?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0) ?: 0
                if (wDp <= 0) wDp = 320
                if (hDp <= 0) hDp = 150
                wDp = wDp.coerceIn(220, 620)
                hDp = hDp.coerceIn(110, 300)

                val s = min(density, MAX_RENDER_W / wDp)
                val wPx = (wDp * s).toInt().coerceAtLeast(64)
                val hPx = (hDp * s).toInt().coerceAtLeast(48)
                // 三星 4×2 实测 401×224dp，比常规 320×150 大一圈；排版单位随高度
                // 放大，否则大卡片上字号偏小、留白过多。
                val t = s * (hDp / 150f).coerceIn(1f, 1.4f)

                val data = WidgetRenderer.Data(
                    vehicleName = vehicleName,
                    soc = if (socShown >= 0f) socShown else null,
                    rangeKm = if (rangeShown >= 0f) rangeShown else null,
                    charging = charging,
                    updatedText = updatedText,
                    vehicle = if (isDemo) null else VehicleImageCache.load(context),
                    locationShort = locationShort,
                    frontPressureBar = frontPressure,
                    rearPressureBar = rearPressure,
                    frontTempC = frontTemp,
                    rearTempC = rearTemp,
                    chargePowerW = chargePowerW,
                    remainChargeMin = remainChargeMin,
                    isStale = isStale,
                    widgetCharacter = WidgetThemeAssetCache.load(context, prefs.getString("widget_asset_character", null), (wPx * 0.24f).toInt().coerceAtLeast(64)),
                    widgetDecoration = WidgetThemeAssetCache.load(context, prefs.getString("widget_asset_decoration", null), wPx.coerceAtMost(1000)),
                    widgetBackground = WidgetThemeAssetCache.load(context, prefs.getString("widget_asset_background", null), wPx.coerceAtMost(1000)),
                    isDemo = isDemo,
                    characterMaxFraction = prefs.getFloat("widget_character_max_fraction", 0.17f).coerceIn(0.1f, 0.2f),
                    characterCropTop = prefs.getFloat("widget_character_crop_top", 0f).coerceIn(0f, 0.8f),
                    characterCropBottom = prefs.getFloat("widget_character_crop_bottom", 1f).coerceIn(0.2f, 1f),
                )

                val full = WidgetRenderer.render(context, wPx, hPx, s, t, theme, data, skin)
                val parts = WidgetRenderer.slice(full, s)
                views.setImageViewBitmap(R.id.widget_hero, parts[0])
                views.setImageViewBitmap(R.id.widget_foot, parts[1])
                views.setImageViewBitmap(R.id.widget_refresh, parts[2])
                val socA11y = if (socShown >= 0f) "电量 ${socShown.toInt()}%" else "电量未知"
                val rangeA11y = if (rangeShown >= 0f) "剩余里程 ${"%.1f".format(rangeShown)} 公里" else "剩余里程未知"
                val chargingA11y = if (isStale) "车辆数据待更新" else if (charging) "正在充电" else "未在充电"
                views.setContentDescription(R.id.widget_hero, "${if (isDemo) "演示模式，" else ""}$vehicleName，$socA11y，$rangeA11y，$chargingA11y")
                views.setContentDescription(R.id.widget_foot, updatedText)
                views.setContentDescription(R.id.widget_refresh, "立即刷新车辆数据")
                // createBitmap(subset) 在尺寸完全相同时会直接返回源对象，
                // 那种情况下不能回收，否则下发的就是一张已释放的位图。
                if (parts.none { it === full }) full.recycle()
            } catch (e: Exception) {
                Log.e(TAG, "render failed", e)
            }

            // ------------------------------------------------------------ 点击
            val launchIntent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val pending = PendingIntent.getActivity(
                context,
                widgetId,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_hero, pending)
            views.setOnClickPendingIntent(R.id.widget_foot, pending)

            // 右下角刷新片 — 广播回本 provider 走一次完整 fetch+render。
            val refreshIntent = Intent(ACTION_REFRESH).apply {
                component = ComponentName(context, NinebotWidgetProvider::class.java)
            }
            val refreshPending = PendingIntent.getBroadcast(
                context,
                widgetId + 5000,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_refresh, refreshPending)

            manager.updateAppWidget(widgetId, views)
        }
    }
}
