package io.github.lovemygoddess.wheelsense.relay

/** Pure decision state for the experimental USB power-bank keep-alive. */
enum class KeepAliveStopReason {
    DISABLED,
    BATTERY_BELOW_THRESHOLD,
    OVER_TEMPERATURE,
    EXTERNAL_POWER_LOST,
    SERVICE_STOPPED,
}

data class KeepAliveInput(
    val enabled: Boolean,
    val serviceRunning: Boolean,
    val externalPowerPresent: Boolean,
    val batteryLevelPct: Int?,
    val temperatureC: Float?,
)

data class KeepAliveDecision(
    val active: Boolean,
    val stopReason: KeepAliveStopReason?,
)

/**
 * START/STOP hysteresis is deliberately kept out of Android scheduling code so
 * it can be tested without a device or a fake PowerManager.
 */
class PowerBankKeepAlivePolicy {
    companion object {
        const val START_BATTERY_PCT = 97
        const val STOP_BATTERY_PCT = 94
        const val STOP_TEMPERATURE_C = 38f
        const val RECOVER_TEMPERATURE_C = 36f
    }

    var active: Boolean = false
        private set

    var thermalBlocked: Boolean = false
        private set

    fun evaluate(input: KeepAliveInput): KeepAliveDecision {
        if (!input.enabled) return stop(KeepAliveStopReason.DISABLED)
        if (!input.serviceRunning) return stop(KeepAliveStopReason.SERVICE_STOPPED)
        if (!input.externalPowerPresent) return stop(KeepAliveStopReason.EXTERNAL_POWER_LOST)

        val temp = input.temperatureC
        if (temp == null || temp >= STOP_TEMPERATURE_C) thermalBlocked = true
        else if (thermalBlocked && temp <= RECOVER_TEMPERATURE_C) thermalBlocked = false
        if (thermalBlocked) return stop(KeepAliveStopReason.OVER_TEMPERATURE)

        val level = input.batteryLevelPct
        if (level == null) return stop(KeepAliveStopReason.BATTERY_BELOW_THRESHOLD)
        if (active && level <= STOP_BATTERY_PCT) {
            return stop(KeepAliveStopReason.BATTERY_BELOW_THRESHOLD)
        }
        if (!active && level < START_BATTERY_PCT) {
            return stop(KeepAliveStopReason.BATTERY_BELOW_THRESHOLD)
        }

        active = true
        return KeepAliveDecision(active = true, stopReason = null)
    }

    fun stop(reason: KeepAliveStopReason): KeepAliveDecision {
        active = false
        return KeepAliveDecision(active = false, stopReason = reason)
    }
}
