package io.github.lovemygoddess.wheelsense.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/**
 * Tracks the relay phone's OWN battery so its health can be reported alongside
 * the BMS board telemetry. Reads from the sticky ACTION_BATTERY_CHANGED
 * broadcast — works on API 21+, needs no extra permission.
 *
 * Values:
 *  - levelPct : 0–100 battery charge %
 *  - tempC    : battery temperature in °C (EXTRA_TEMPERATURE is in tenths of °C)
 *  - charging : true when AC/USB/wireless plugged in
 *  - voltageV : battery voltage in V (EXTRA_VOLTAGE is in mV)
 */
class PhoneBatteryMonitor(private val ctx: Context) {

data class Sample(
        val levelPct: Int?,
        val tempC: Float?,
        val charging: Boolean,
        val voltageV: Float?,
        val batteryStatus: Int?,
        val plugged: Int?,
        val externalPowerPresent: Boolean,
        val currentNowUa: Long?,
    )

    @Volatile var levelPct: Int? = null
        private set
    @Volatile var tempC: Float? = null
        private set
    @Volatile var charging: Boolean = false
        private set
    @Volatile var voltageV: Float? = null
        private set
    @Volatile var batteryStatus: Int? = null
        private set
    @Volatile var plugged: Int? = null
        private set
    @Volatile var externalPowerPresent: Boolean = false
        private set
    @Volatile var currentNowUa: Long? = null
        private set

    /** ACTION_POWER_* is intentionally surfaced separately from the sticky
     * battery sample: a power-bank shutdown must stop a pulse immediately. */
    var onPowerEvent: ((connected: Boolean) -> Unit)? = null
    var onSampleChanged: (() -> Unit)? = null

    private val batteryManager: BatteryManager? by lazy {
        ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent == null) return
            when (intent.action) {
                Intent.ACTION_POWER_CONNECTED -> {
                    externalPowerPresent = true
                    charging = true
                    onPowerEvent?.invoke(true)
                    onSampleChanged?.invoke()
                    return
                }
                Intent.ACTION_POWER_DISCONNECTED -> {
                    externalPowerPresent = false
                    charging = false
                    onPowerEvent?.invoke(false)
                    onSampleChanged?.invoke()
                    return
                }
            }
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            levelPct = if (level >= 0 && scale > 0) (level * 100f / scale).toInt() else null

            val t = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            tempC = if (t != Int.MIN_VALUE) t / 10f else null

            val v = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
            voltageV = if (v > 0) v / 1000f else null

            val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
            this@PhoneBatteryMonitor.plugged = plugged.takeIf { it >= 0 }
            val wasPowered = externalPowerPresent
            externalPowerPresent = plugged > 0
            charging = externalPowerPresent

            val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            batteryStatus = status.takeIf { it >= 0 }
            currentNowUa = batteryManager?.let { manager ->
                try {
                    val value = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
                    value.takeIf { it != Int.MIN_VALUE && it != 0 }?.toLong()
                } catch (_: Throwable) {
                    null
                }
            }
            if (wasPowered != externalPowerPresent) onPowerEvent?.invoke(externalPowerPresent)
            onSampleChanged?.invoke()
        }
    }

    fun start() {
        // registerReceiver immediately returns the current sticky intent.
        try {
            val filter = IntentFilter().apply {
                addAction(Intent.ACTION_BATTERY_CHANGED)
                addAction(Intent.ACTION_POWER_CONNECTED)
                addAction(Intent.ACTION_POWER_DISCONNECTED)
            }
            receiver.onReceive(ctx, ctx.registerReceiver(receiver, filter))
        } catch (_: Exception) {
        }
    }

    fun stop() {
        try {
            ctx.unregisterReceiver(receiver)
        } catch (_: Exception) {
        }
    }

    fun sample(): Sample = Sample(
        levelPct = levelPct,
        tempC = tempC,
        charging = charging,
        voltageV = voltageV,
        batteryStatus = batteryStatus,
        plugged = plugged,
        externalPowerPresent = externalPowerPresent,
        currentNowUa = currentNowUa,
    )
}
