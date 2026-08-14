package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * Keeps a USB power bank from cutting its own output, and reacts when it does.
 *
 * The problem: almost every power bank shuts the output down when the load
 * drops below ~50–100 mA, so it doesn't stay awake forever powering nothing.
 * A parked relay phone draws roughly 50 mA — right on that threshold. Once the
 * bank cuts power the phone stops drawing current entirely, so the bank never
 * sees a load again and never comes back. It is a genuine deadlock, and the
 * usual symptom is "the relay worked for two days then died" long after anyone
 * would connect it to the power bank rather than the app.
 *
 * The mitigation is to periodically look like a real load: a short burst of
 * CPU work pulls a few hundred milliamps for a few seconds, which is enough to
 * re-arm the bank's auto-shutoff timer. The energy cost is negligible — a 5 s
 * burst every 20 min is well under 1% of a 20 000 mAh bank per day.
 *
 * This is a workaround, not a guarantee. Banks with an explicit low-current /
 * trickle mode (usually a double-press of the button) are strictly better, and
 * a sub-¥10 USB load resistor solves it in hardware.
 *
 * The second job here is detection: when external power really is gone, the
 * sampling cadence should drop so the phone survives long enough to still be
 * holding its data when it's next found.
 */
class PowerBankKeepAlive(
    private val ctx: Context,
    private val battery: PhoneBatteryMonitor,
) {

    companion object {
        /** How often to present a load to the bank. */
        private const val PULSE_INTERVAL_MS = 30 * 60_000L

        /** Burst length. Long enough for the bank's detector, short enough to
         *  cost nothing meaningful. */
        private const val PULSE_DURATION_MS = 2_000L

        /** Threads to spin. Two is plenty for ~300 mA on this class of SoC and
         *  leaves headroom so the BLE loop keeps its timing. */
        private const val PULSE_THREADS = 1

        /** Unplugged for longer than this ⇒ treat external power as gone. */
        private const val POWER_LOST_CONFIRM_MS = 5 * 60_000L
    }

    /** Raised/cleared as external power comes and goes. */
    var onPowerStateChanged: ((powered: Boolean) -> Unit)? = null
    var onStatus: ((String) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile var externalPowerPresent = true
        private set

    private var unpoweredSinceElapsed = 0L
    private var pulsing = false

    private val pulseRunnable = object : Runnable {
        override fun run() {
            // No point pulsing when the bank has already cut out — the phone
            // is on its own battery and the burst would only waste it.
            if (externalPowerPresent) emitLoadPulse()
            mainHandler.postDelayed(this, PULSE_INTERVAL_MS)
        }
    }

    private val watchRunnable = object : Runnable {
        override fun run() {
            evaluatePowerState()
            mainHandler.postDelayed(this, 60_000L)
        }
    }

    fun start() {
        mainHandler.postDelayed(pulseRunnable, PULSE_INTERVAL_MS)
        mainHandler.postDelayed(watchRunnable, 60_000L)
    }

    fun stop() {
        mainHandler.removeCallbacks(pulseRunnable)
        mainHandler.removeCallbacks(watchRunnable)
    }

    /**
     * Charging state flaps briefly whenever the phone tops off, so a single
     * "not charging" reading means nothing. Only a sustained absence counts.
     */
    private fun evaluatePowerState() {
        val charging = battery.sample()?.charging ?: return
        val now = SystemClock.elapsedRealtime()

        if (charging) {
            if (!externalPowerPresent) {
                externalPowerPresent = true
                unpoweredSinceElapsed = 0L
                onStatus?.invoke("外部供电已恢复")
                onPowerStateChanged?.invoke(true)
            }
            unpoweredSinceElapsed = 0L
            return
        }

        if (unpoweredSinceElapsed == 0L) {
            unpoweredSinceElapsed = now
            return
        }
        if (externalPowerPresent && now - unpoweredSinceElapsed >= POWER_LOST_CONFIRM_MS) {
            externalPowerPresent = false
            onStatus?.invoke("外部供电中断，转省电模式")
            onPowerStateChanged?.invoke(false)
        }
    }

    /**
     * Short multi-threaded busy-wait. Deliberately crude: the goal is current
     * draw, not useful work. Threads are plain daemons so a service teardown
     * mid-pulse can never hold the process open.
     */
    private fun emitLoadPulse() {
        if (pulsing) return
        pulsing = true
        val deadline = SystemClock.elapsedRealtime() + PULSE_DURATION_MS
        for (i in 0 until PULSE_THREADS) {
            Thread {
                var acc = 0.0
                var n = 0L
                while (SystemClock.elapsedRealtime() < deadline) {
                    // Floating-point work keeps the core genuinely busy; the
                    // accumulator exists only so the loop can't be optimised out.
                    acc += Math.sqrt((n % 10_000).toDouble() + 1.0)
                    n++
                }
                if (acc < 0) onStatus?.invoke("")
            }.apply {
                isDaemon = true
                priority = Thread.MIN_PRIORITY
            }.start()
        }
        mainHandler.postDelayed({ pulsing = false }, PULSE_DURATION_MS + 500L)
    }
}
