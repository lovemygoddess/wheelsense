package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Experimental software keep-alive for USB power banks that shut down at a
 * very low load. V2 keeps one bounded PARTIAL_WAKE_LOCK for the whole safe
 * external-power window, then emits a deterministic single-worker load pulse
 * every ten seconds. It fails closed immediately when power, battery, thermal
 * or service conditions leave that window.
 */
class PowerBankKeepAlive(
    private val ctx: Context,
    private val battery: PhoneBatteryMonitor,
    enabledInitially: Boolean = RelayConfig.DEFAULT_POWER_BANK_KEEPALIVE_ENABLED,
) {

    enum class PulseProfile(val durationMs: Long) {
        LOW(1_000L),
        MEDIUM(2_000L),
        HIGH(2_000L),
    }

    data class Diagnostics(
        val enabled: Boolean,
        val active: Boolean,
        val pulseCount: Long,
        val lastPulseAt: Long?,
        val lastPulseDurationMs: Long?,
        val pulseIntervalLastMs: Long?,
        val pulseIntervalMaxMs: Long?,
        val scheduledAt: Long?,
        val actualStartedAt: Long?,
        val scheduleDelayMs: Long?,
        val scheduleDelayMaxMs: Long?,
        val wakeLockHeld: Boolean,
        val wakeLockHeldAt: Long?,
        val externalPowerPresent: Boolean,
        val externalPowerConnectedAt: Long?,
        val externalPowerLostAt: Long?,
        val externalPowerRestoredAt: Long?,
        val batteryLevelAtPowerLoss: Int?,
        val temperatureAtPowerLoss: Float?,
        val lossLastPulseAgeMs: Long?,
        val lossLastPulseIntervalMs: Long?,
        val lossScheduleDelayMs: Long?,
        val lossPulseCount: Long?,
        val stopReason: KeepAliveStopReason?,
        val currentBeforeUa: Long?,
        val currentDuringUa: Long?,
        val currentAfterUa: Long?,
    )

    /** One externally observable power transition. V2 scheduling never reads
     * this object; it is an audit record only. */
    data class PowerEvent(
        val type: Type,
        val atMs: Long,
        val externalPowerPresent: Boolean,
        val charging: Boolean,
        val plugged: Int?,
        val keepAliveActive: Boolean,
        val wakeLockHeld: Boolean,
        val batteryPct: Int?,
        val temperatureC: Float?,
        val currentNowUa: Long?,
        val pulseCount: Long,
        val pulseAgeMs: Long?,
        val pulseIntervalMs: Long?,
        val scheduleDelayMs: Long?,
        val durationMs: Long? = null,
    ) {
        enum class Type { DISCONNECTED, RESTORED }
    }

    companion object {
        const val PULSE_INTERVAL_MS = 10_000L
        const val PULSE_DURATION_MS = 2_000L
        private const val EVALUATION_INTERVAL_MS = 5_000L
        private const val TAG = "WheelSense::PowerBankKeepAlive"
    }

    var onPowerStateChanged: ((powered: Boolean) -> Unit)? = null
    /** Durable event observer; intentionally separate from the V2 policy. */
    var onPowerEvent: ((PowerEvent) -> Unit)? = null
    var onStatus: ((String) -> Unit)? = null

    @Volatile var enabled: Boolean = enabledInitially
        set(value) {
            field = value
            evaluate()
        }

    @Volatile var externalPowerPresent: Boolean = false
        private set

    /** Restore only the transition baseline; the next real battery sample
     * still decides the current state. This preserves event pairing across a
     * service restart without changing any Keep-Alive policy decision. */
    fun restorePowerStateBaseline(previous: Boolean?) {
        if (previous != null) {
            lastPowerState = previous
            externalPowerPresent = previous
        }
    }

    private val policy = PowerBankKeepAlivePolicy()
    private val cancelPulse = AtomicBoolean(false)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "PowerBankKeepAlive").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }
    private var pulseFuture: Future<*>? = null
    private var serviceRunning = false
    private var pulsing = false
    private var lastReportedActive = false
    private var lastReportedReason: KeepAliveStopReason? = null
    private var lastPowerState: Boolean? = null

    @Volatile private var pulseCount = 0L
    @Volatile private var lastPulseAt: Long? = null
    @Volatile private var lastPulseDurationMs: Long? = null
    @Volatile private var pulseIntervalLastMs: Long? = null
    @Volatile private var pulseIntervalMaxMs: Long? = null
    @Volatile private var scheduledAt: Long? = null
    @Volatile private var actualStartedAt: Long? = null
    @Volatile private var scheduleDelayMs: Long? = null
    @Volatile private var scheduleDelayMaxMs: Long? = null
    @Volatile private var externalPowerConnectedAt: Long? = null
    @Volatile private var externalPowerLostAt: Long? = null
    @Volatile private var externalPowerRestoredAt: Long? = null
    @Volatile private var batteryLevelAtPowerLoss: Int? = null
    @Volatile private var temperatureAtPowerLoss: Float? = null
    @Volatile private var lossLastPulseAgeMs: Long? = null
    @Volatile private var lossLastPulseIntervalMs: Long? = null
    @Volatile private var lossScheduleDelayMs: Long? = null
    @Volatile private var lossPulseCount: Long? = null
    @Volatile private var currentBeforeUa: Long? = null
    @Volatile private var currentDuringUa: Long? = null
    @Volatile private var currentAfterUa: Long? = null
    private var overheatReported = false

    private var persistentWakeLock: PowerManager.WakeLock? = null
    @Volatile private var wakeLockHeldAt: Long? = null

    private val scheduler = Handler(Looper.getMainLooper())

    private val pulseRunnable = object : Runnable {
        override fun run() {
            if (serviceRunning && policy.active && externalPowerPresent) emitLoadPulse()
            if (serviceRunning) scheduler.postDelayed(this, PULSE_INTERVAL_MS)
        }
    }

    private val evaluationRunnable = object : Runnable {
        override fun run() {
            if (!serviceRunning) return
            evaluate()
            scheduler.postDelayed(this, EVALUATION_INTERVAL_MS)
        }
    }

    fun start() {
        if (serviceRunning) return
        serviceRunning = true
        battery.onPowerEvent = { connected -> onPowerEvent(connected) }
        battery.onSampleChanged = { evaluate() }
        evaluate()
        scheduler.postDelayed(pulseRunnable, PULSE_INTERVAL_MS)
        scheduler.postDelayed(evaluationRunnable, EVALUATION_INTERVAL_MS)
    }

    fun stop() {
        serviceRunning = false
        scheduler.removeCallbacks(pulseRunnable)
        scheduler.removeCallbacks(evaluationRunnable)
        battery.onPowerEvent = null
        battery.onSampleChanged = null
        policy.stop(KeepAliveStopReason.SERVICE_STOPPED)
        cancelPulse.set(true)
        pulseFuture?.cancel(true)
        pulseFuture = null
        pulsing = false
        releasePersistentWakeLock()
        executor.shutdownNow()
        emitStatusIfChanged(false, KeepAliveStopReason.SERVICE_STOPPED)
    }

    private fun onPowerEvent(connected: Boolean) {
        updatePowerState(connected, battery.sample())
        evaluate()
    }

    /** Apply a power transition exactly once, including the frozen loss data. */
    private fun updatePowerState(connected: Boolean, sample: PhoneBatteryMonitor.Sample) {
        val previous = lastPowerState
        externalPowerPresent = connected
        if (previous == connected) return
        lastPowerState = connected
        val now = System.currentTimeMillis()
        if (connected) {
            externalPowerRestoredAt = now
            externalPowerConnectedAt = now
            if (previous == false) {
                try {
                    onPowerEvent?.invoke(
                        PowerEvent(
                        type = PowerEvent.Type.RESTORED,
                        atMs = now,
                        externalPowerPresent = true,
                        charging = sample.charging,
                        plugged = sample.plugged,
                        keepAliveActive = policy.active,
                        wakeLockHeld = isWakeLockHeld(),
                        batteryPct = sample.levelPct,
                        temperatureC = sample.tempC,
                        currentNowUa = sample.currentNowUa,
                        pulseCount = pulseCount,
                        pulseAgeMs = lastPulseAt?.let { (now - it).coerceAtLeast(0L) },
                        pulseIntervalMs = pulseIntervalLastMs,
                        scheduleDelayMs = scheduleDelayMs,
                        durationMs = externalPowerLostAt?.let { (now - it).coerceAtLeast(0L) },
                        ),
                    )
                } catch (_: Throwable) { }
            }
            onPowerStateChanged?.invoke(true)
            onStatus?.invoke("外部供电已恢复，Keep-Alive 条件重新评估")
        } else {
            if (previous == true) {
                externalPowerLostAt = now
                batteryLevelAtPowerLoss = sample.levelPct
                temperatureAtPowerLoss = sample.tempC
                lossLastPulseAgeMs = lastPulseAt?.let { (now - it).coerceAtLeast(0L) }
                lossLastPulseIntervalMs = pulseIntervalLastMs
                lossScheduleDelayMs = scheduleDelayMs
                lossPulseCount = pulseCount
                try {
                    onPowerEvent?.invoke(
                        PowerEvent(
                        type = PowerEvent.Type.DISCONNECTED,
                        atMs = now,
                        externalPowerPresent = false,
                        charging = sample.charging,
                        plugged = sample.plugged,
                        keepAliveActive = policy.active,
                        wakeLockHeld = isWakeLockHeld(),
                        batteryPct = sample.levelPct,
                        temperatureC = sample.tempC,
                        currentNowUa = sample.currentNowUa,
                        pulseCount = pulseCount,
                        pulseAgeMs = lossLastPulseAgeMs,
                        pulseIntervalMs = pulseIntervalLastMs,
                        scheduleDelayMs = scheduleDelayMs,
                        ),
                    )
                } catch (_: Throwable) { }
            }
            cancelPulse.set(true)
            pulseFuture?.cancel(true)
            pulseFuture = null
            policy.stop(KeepAliveStopReason.EXTERNAL_POWER_LOST)
            releasePersistentWakeLock()
            onPowerStateChanged?.invoke(false)
            emitStatusIfChanged(false, KeepAliveStopReason.EXTERNAL_POWER_LOST)
            onStatus?.invoke("外部供电中断，已停止 Keep-Alive")
        }
    }

    private fun evaluate() {
        val sample = battery.sample()
        if ((sample.tempC ?: Float.MAX_VALUE) >= 42f && !overheatReported) {
            overheatReported = true
            onStatus?.invoke("PWR_KEEPALIVE_OVERHEAT")
        } else if ((sample.tempC ?: Float.MAX_VALUE) <= PowerBankKeepAlivePolicy.RECOVER_TEMPERATURE_C) {
            overheatReported = false
        }
        val observedPower = sample.externalPowerPresent
        if (lastPowerState == null || lastPowerState != observedPower) {
            updatePowerState(observedPower, sample)
        } else {
            externalPowerPresent = observedPower
        }
        val decision = policy.evaluate(
            KeepAliveInput(
                enabled = enabled,
                serviceRunning = serviceRunning,
                externalPowerPresent = externalPowerPresent,
                batteryLevelPct = sample.levelPct,
                temperatureC = sample.tempC,
            ),
        )
        if (!decision.active) {
            cancelPulse.set(true)
            releasePersistentWakeLock()
        } else {
            cancelPulse.set(false)
            ensurePersistentWakeLock()
        }
        emitStatusIfChanged(decision.active, decision.stopReason)
    }

    private fun ensurePersistentWakeLock() {
        if (!serviceRunning || !policy.active || !externalPowerPresent) return
        try {
            val manager = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val lock = persistentWakeLock ?: manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG).apply {
                setReferenceCounted(false)
            }.also { persistentWakeLock = it }
            if (!lock.isHeld) {
                lock.acquire()
                wakeLockHeldAt = System.currentTimeMillis()
            }
        } catch (_: Throwable) {
            // A missing/denied wake lock must not crash the relay; diagnostics
            // will show WL=0 while the policy continues to fail closed on power.
        }
    }

    private fun releasePersistentWakeLock() {
        val lock = persistentWakeLock ?: run {
            wakeLockHeldAt = null
            return
        }
        try {
            if (lock.isHeld) lock.release()
        } catch (_: Throwable) {
        } finally {
            wakeLockHeldAt = null
            persistentWakeLock = null
        }
    }

    private fun isWakeLockHeld(): Boolean = try {
        persistentWakeLock?.isHeld == true
    } catch (_: Throwable) {
        false
    }

    private fun emitStatusIfChanged(active: Boolean, reason: KeepAliveStopReason?) {
        if (active == lastReportedActive && reason == lastReportedReason) return
        lastReportedActive = active
        lastReportedReason = reason
        onStatus?.invoke(if (active) "Keep-Alive V2 已启用" else "Keep-Alive 已停止：${reason?.name ?: "-"}")
    }

    private fun emitLoadPulse() {
        synchronized(this) {
            if (pulsing || !serviceRunning || !policy.active || !externalPowerPresent) return
            pulsing = true
            cancelPulse.set(false)
            val scheduledWall = System.currentTimeMillis()
            val scheduledElapsed = SystemClock.elapsedRealtime()
            scheduledAt = scheduledWall
            pulseFuture = executor.submit { runPulse(scheduledWall, scheduledElapsed) }
        }
    }

    private fun runPulse(scheduledWall: Long, scheduledElapsed: Long) {
        val duration = PulseProfile.MEDIUM.durationMs
        val startedElapsed = SystemClock.elapsedRealtime()
        val startedWall = System.currentTimeMillis()
        actualStartedAt = startedWall
        val delay = (startedElapsed - scheduledElapsed).coerceAtLeast(0L)
        scheduleDelayMs = delay
        scheduleDelayMaxMs = maxOf(scheduleDelayMaxMs ?: 0L, delay)
        var completed = false
        try {
            currentBeforeUa = battery.sample().currentNowUa
            val deadline = startedElapsed + duration
            var value = 0x9E3779B9.toInt()
            var iterations = 0L
            while (
                SystemClock.elapsedRealtime() < deadline &&
                    !cancelPulse.get() &&
                    !Thread.currentThread().isInterrupted &&
                    serviceRunning &&
                    externalPowerPresent
            ) {
                // Deterministic, bounded CPU work: no I/O, allocation or main
                // thread work, and never more than one worker.
                value = value xor (value shl 13)
                value += 0x7F4A7C15
                value = value xor (value ushr 17)
                iterations++
                if (iterations and 0x3FFFFL == 0L) currentDuringUa = battery.sample().currentNowUa
            }
            currentDuringUa = battery.sample().currentNowUa
            currentAfterUa = battery.sample().currentNowUa
            completed = SystemClock.elapsedRealtime() >= deadline &&
                !cancelPulse.get() && serviceRunning && externalPowerPresent &&
                !Thread.currentThread().isInterrupted
            if (completed) {
                val previous = lastPulseAt
                pulseIntervalLastMs = previous?.let { (startedWall - it).coerceAtLeast(0L) }
                pulseIntervalLastMs?.let { pulseIntervalMaxMs = maxOf(pulseIntervalMaxMs ?: 0L, it) }
                lastPulseAt = startedWall
                lastPulseDurationMs = SystemClock.elapsedRealtime() - startedElapsed
                pulseCount++
            }
            if (value == Int.MIN_VALUE) onStatus?.invoke("")
        } finally {
            synchronized(this) {
                pulsing = false
                pulseFuture = null
            }
            if (!completed && !externalPowerPresent) releasePersistentWakeLock()
        }
    }

    fun diagnostics(): Diagnostics {
        val sample = battery.sample()
        val held = try { persistentWakeLock?.isHeld == true } catch (_: Throwable) { false }
        return Diagnostics(
            enabled = enabled,
            active = policy.active,
            pulseCount = pulseCount,
            lastPulseAt = lastPulseAt,
            lastPulseDurationMs = lastPulseDurationMs,
            pulseIntervalLastMs = pulseIntervalLastMs,
            pulseIntervalMaxMs = pulseIntervalMaxMs,
            scheduledAt = scheduledAt,
            actualStartedAt = actualStartedAt,
            scheduleDelayMs = scheduleDelayMs,
            scheduleDelayMaxMs = scheduleDelayMaxMs,
            wakeLockHeld = held,
            wakeLockHeldAt = wakeLockHeldAt,
            externalPowerPresent = externalPowerPresent,
            externalPowerConnectedAt = externalPowerConnectedAt,
            externalPowerLostAt = externalPowerLostAt,
            externalPowerRestoredAt = externalPowerRestoredAt,
            batteryLevelAtPowerLoss = batteryLevelAtPowerLoss,
            temperatureAtPowerLoss = temperatureAtPowerLoss,
            lossLastPulseAgeMs = lossLastPulseAgeMs,
            lossLastPulseIntervalMs = lossLastPulseIntervalMs,
            lossScheduleDelayMs = lossScheduleDelayMs,
            lossPulseCount = lossPulseCount,
            stopReason = lastReportedReason,
            currentBeforeUa = currentBeforeUa ?: sample.currentNowUa,
            currentDuringUa = currentDuringUa,
            currentAfterUa = currentAfterUa,
        )
    }

    /** Compact form placed at the front of the heartbeat diagnostics string. */
    fun compactDiagnostics(): String {
        val d = diagnostics()
        val now = System.currentTimeMillis()
        fun age(at: Long?): String = at?.let { ((now - it).coerceAtLeast(0L) / 1000L).toString() } ?: "-"
        val sample = battery.sample()
        // Keep event counters near the front: the existing server stores only
        // the first 120 chars of ble_status. The compact keys are documented
        // by PowerEventStore (dc=disconnect count, da=last age, dd=duration,
        // dm=max duration) and do not alter any V2 threshold or cadence.
        val eventSummary = powerEventDiagnosticsProvider?.invoke()?.let { "$it," } ?: ""
        return "PWR:ext=${if (d.externalPowerPresent) 1 else 0}," +
            eventSummary +
            "bat=${sample.levelPct ?: "-"},chg=${if (sample.charging) 1 else 0}," +
            "temp=${sample.tempC?.let { "%.1f".format(it) } ?: "-"}," +
            "KA=${if (d.active) "ON" else "OFF"},WL=${if (d.wakeLockHeld) 1 else 0}," +
            "pulseAge=${age(d.lastPulseAt)},delayMax=${d.scheduleDelayMaxMs ?: "-"}," +
            "lossAge=${age(d.externalPowerLostAt)},pc=${d.pulseCount}"
    }

    /** Injected by the service so the policy remains independent of storage. */
    var powerEventDiagnosticsProvider: (() -> String)? = null
}
