package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Small durable journal for external-power transitions.
 *
 * Power events are deliberately kept out of the telemetry outbox: the
 * current server batch contract does not have a power-event kind and would
 * acknowledge unknown rows as dead letters.  This bounded journal therefore
 * survives a service restart/power cut locally while the compact summary is
 * included in the next heartbeat.  A future server event endpoint can replay
 * the same JSON shape without changing the V2 workload.
 */
class PowerEventStore(context: Context) {
    data class Summary(
        val disconnectCount: Long,
        val reconnectCount: Long,
        val autoRecoveryCount: Long,
        val lastDisconnectAt: Long?,
        val lastReconnectAt: Long?,
        val lastDurationMs: Long?,
        val maxDurationMs: Long?,
        val totalDurationMs: Long,
    )

    companion object {
        private const val PREFS = "relay_power_events"
        private const val EVENTS_KEY = "events"
        private const val COUNT_KEY = "disconnect_count"
        private const val RECONNECT_COUNT_KEY = "reconnect_count"
        private const val AUTO_RECOVERY_COUNT_KEY = "auto_recovery_count"
        private const val LAST_DISCONNECT_AT_KEY = "last_disconnect_at"
        private const val LAST_RECONNECT_AT_KEY = "last_reconnect_at"
        private const val LAST_DURATION_KEY = "last_duration_ms"
        private const val MAX_DURATION_KEY = "max_duration_ms"
        private const val TOTAL_DURATION_KEY = "total_duration_ms"
        private const val LAST_POWER_PRESENT_KEY = "last_power_present"
        private const val HAS_LAST_POWER_PRESENT_KEY = "has_last_power_present"
        private const val MAX_EVENTS = 32
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun record(event: PowerBankKeepAlive.PowerEvent) {
        val events = readEvents()
        when (event.type) {
            PowerBankKeepAlive.PowerEvent.Type.DISCONNECTED -> {
                events.put(event.toJson())
                val count = prefs.getLong(COUNT_KEY, 0L) + 1L
                persist(
                    events = events,
                    disconnectCount = count,
                    reconnectCount = prefs.getLong(RECONNECT_COUNT_KEY, 0L),
                    autoRecoveryCount = prefs.getLong(AUTO_RECOVERY_COUNT_KEY, 0L),
                    lastDisconnectAt = event.atMs,
                    lastReconnectAt = prefs.getLong(LAST_RECONNECT_AT_KEY, 0L),
                    lastDurationMs = -1L,
                    maxDurationMs = prefs.getLong(MAX_DURATION_KEY, 0L),
                    totalDurationMs = prefs.getLong(TOTAL_DURATION_KEY, 0L),
                    lastPowerPresent = false,
                )
            }
            PowerBankKeepAlive.PowerEvent.Type.RESTORED -> {
                var matched = false
                var matchedDuration: Long? = null
                for (i in events.length() - 1 downTo 0) {
                    val item = events.optJSONObject(i) ?: continue
                    if (item.optString("type") == "POWER_DISCONNECTED" &&
                        !item.has("restored_at")) {
                        val restoredAt = event.atMs
                        item.put("restored_at", restoredAt)
                        matchedDuration = (restoredAt - item.optLong("at_ms", restoredAt)).coerceAtLeast(0L)
                        item.put("duration_ms", matchedDuration)
                        matched = true
                        break
                    }
                }
                val duration = matchedDuration ?: event.durationMs
                events.put(event.toJson())
                val oldMax = prefs.getLong(MAX_DURATION_KEY, 0L)
                val oldTotal = prefs.getLong(TOTAL_DURATION_KEY, 0L)
                persist(
                    events = events,
                    disconnectCount = prefs.getLong(COUNT_KEY, 0L),
                    reconnectCount = prefs.getLong(RECONNECT_COUNT_KEY, 0L) + 1L,
                    autoRecoveryCount = prefs.getLong(AUTO_RECOVERY_COUNT_KEY, 0L) + if (matched) 1L else 0L,
                    lastDisconnectAt = prefs.getLong(LAST_DISCONNECT_AT_KEY, 0L),
                    lastReconnectAt = event.atMs,
                    lastDurationMs = duration ?: -1L,
                    maxDurationMs = maxOf(oldMax, duration ?: 0L),
                    totalDurationMs = oldTotal + (duration ?: 0L),
                    lastPowerPresent = true,
                )
            }
        }
    }

    /** Last observed state lets a restarted service preserve the transition
     * baseline instead of treating its first sample as a new event. */
    @Synchronized
    fun lastPowerPresent(): Boolean? = if (prefs.getBoolean(HAS_LAST_POWER_PRESENT_KEY, false)) {
        prefs.getBoolean(LAST_POWER_PRESENT_KEY, false)
    } else null

    @Synchronized
    fun rememberPowerState(present: Boolean) {
        prefs.edit()
            .putBoolean(LAST_POWER_PRESENT_KEY, present)
            .putBoolean(HAS_LAST_POWER_PRESENT_KEY, true)
            .commit()
    }

    @Synchronized
    fun summary(nowMs: Long = System.currentTimeMillis()): Summary {
        val events = readEvents()
        var lastAt: Long? = null
        var lastDuration: Long? = null
        var maxDuration: Long? = null
        var latestDisconnectSeen = false
        for (i in events.length() - 1 downTo 0) {
            val item = events.optJSONObject(i) ?: continue
            if (item.optString("type") != "POWER_DISCONNECTED") continue
            if (!latestDisconnectSeen) {
                lastAt = item.optLong("at_ms", 0L).takeIf { it > 0L }
                lastDuration = item.optLong("duration_ms", -1L).takeIf { it >= 0L }
                latestDisconnectSeen = true
            }
            val duration = item.optLong("duration_ms", -1L).takeIf { it >= 0L }
            if (duration != null) maxDuration = maxOf(maxDuration ?: 0L, duration)
        }
        return Summary(
            disconnectCount = prefs.getLong(COUNT_KEY, 0L),
            reconnectCount = prefs.getLong(RECONNECT_COUNT_KEY, 0L),
            autoRecoveryCount = prefs.getLong(AUTO_RECOVERY_COUNT_KEY, 0L),
            lastDisconnectAt = lastAt ?: prefs.getLong(LAST_DISCONNECT_AT_KEY, 0L).takeIf { it > 0L },
            lastReconnectAt = prefs.getLong(LAST_RECONNECT_AT_KEY, 0L).takeIf { it > 0L },
            lastDurationMs = if (latestDisconnectSeen) lastDuration
            else prefs.getLong(LAST_DURATION_KEY, -1L).takeIf { it >= 0L },
            maxDurationMs = maxDuration ?: prefs.getLong(MAX_DURATION_KEY, 0L).takeIf { it > 0L },
            totalDurationMs = prefs.getLong(TOTAL_DURATION_KEY, 0L),
        )
    }

    /** Compact ASCII fields fit in the existing heartbeat prefix. */
    @Synchronized
    fun compact(nowMs: Long = System.currentTimeMillis()): String {
        val s = summary(nowMs)
        fun age(at: Long?): String = at?.let { ((nowMs - it).coerceAtLeast(0L) / 1000L).toString() } ?: "-"
        fun seconds(ms: Long?): String = ms?.let { (it.coerceAtLeast(0L) / 1000L).toString() } ?: "-"
        return "dc=${s.disconnectCount},da=${age(s.lastDisconnectAt)},dd=${seconds(s.lastDurationMs)},dm=${seconds(s.maxDurationMs)}"
    }

    private fun readEvents(): JSONArray {
        val raw = prefs.getString(EVENTS_KEY, null) ?: return JSONArray()
        return try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
    }

    private fun persist(
        events: JSONArray,
        disconnectCount: Long,
        reconnectCount: Long,
        autoRecoveryCount: Long,
        lastDisconnectAt: Long,
        lastReconnectAt: Long,
        lastDurationMs: Long,
        maxDurationMs: Long,
        totalDurationMs: Long,
        lastPowerPresent: Boolean,
    ) {
        while (events.length() > MAX_EVENTS) events.remove(0)
        // commit keeps the last transition durable before the phone can lose power.
        prefs.edit()
            .putString(EVENTS_KEY, events.toString())
            .putLong(COUNT_KEY, disconnectCount)
            .putLong(RECONNECT_COUNT_KEY, reconnectCount)
            .putLong(AUTO_RECOVERY_COUNT_KEY, autoRecoveryCount)
            .putLong(LAST_DISCONNECT_AT_KEY, lastDisconnectAt)
            .putLong(LAST_RECONNECT_AT_KEY, lastReconnectAt)
            .putLong(LAST_DURATION_KEY, lastDurationMs)
            .putLong(MAX_DURATION_KEY, maxDurationMs)
            .putLong(TOTAL_DURATION_KEY, totalDurationMs)
            .putBoolean(LAST_POWER_PRESENT_KEY, lastPowerPresent)
            .putBoolean(HAS_LAST_POWER_PRESENT_KEY, true)
            .commit()
    }

    private fun PowerBankKeepAlive.PowerEvent.toJson(): JSONObject = JSONObject().apply {
        put("type", if (type == PowerBankKeepAlive.PowerEvent.Type.DISCONNECTED) {
            "POWER_DISCONNECTED"
        } else {
            "POWER_CONNECTED"
        })
        put("at_ms", atMs)
        put("external_power_present", externalPowerPresent)
        put("charging", charging)
        plugged?.let { put("plugged", it) }
        put("keepalive_active", keepAliveActive)
        put("wakelock_held", wakeLockHeld)
        batteryPct?.let { put("battery_pct", it) }
        temperatureC?.let { put("temperature_c", it.toDouble()) }
        currentNowUa?.let { put("current_ua", it) }
        put("pulse_count", pulseCount)
        pulseAgeMs?.let { put("pulse_age_ms", it) }
        pulseIntervalMs?.let { put("pulse_interval_ms", it) }
        scheduleDelayMs?.let { put("schedule_delay_ms", it) }
        durationMs?.let { put("duration_ms", it) }
    }
}
