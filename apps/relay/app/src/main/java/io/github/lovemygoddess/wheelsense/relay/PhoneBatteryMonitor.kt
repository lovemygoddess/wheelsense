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
    )

    @Volatile var levelPct: Int? = null
        private set
    @Volatile var tempC: Float? = null
        private set
    @Volatile var charging: Boolean = false
        private set
    @Volatile var voltageV: Float? = null
        private set

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, intent: Intent?) {
            if (intent == null) return
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            levelPct = if (level >= 0 && scale > 0) (level * 100f / scale).toInt() else null

            val t = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            tempC = if (t != Int.MIN_VALUE) t / 10f else null

            val v = intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
            voltageV = if (v > 0) v / 1000f else null

            val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
            charging = plugged != 0
        }
    }

    fun start() {
        // registerReceiver immediately returns the current sticky intent.
        try {
            receiver.onReceive(ctx, ctx.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED)))
        } catch (_: Exception) {
        }
    }

    fun stop() {
        try {
            ctx.unregisterReceiver(receiver)
        } catch (_: Exception) {
        }
    }

    fun sample(): Sample = Sample(levelPct, tempC, charging, voltageV)
}
