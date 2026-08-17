package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class PowerBankKeepAliveV2Test {
    @Test
    fun v2PulseCadenceAndDurationAreBounded() {
        assertEquals(10_000L, PowerBankKeepAlive.PULSE_INTERVAL_MS)
        assertEquals(2_000L, PowerBankKeepAlive.PULSE_DURATION_MS)
        assertEquals(2_000L, PowerBankKeepAlive.PulseProfile.MEDIUM.durationMs)
    }

    @Test
    fun powerEventModelKeepsPowerAndKeepAliveSnapshotFields() {
        val event = PowerBankKeepAlive.PowerEvent(
            type = PowerBankKeepAlive.PowerEvent.Type.DISCONNECTED,
            atMs = 1000L,
            externalPowerPresent = false,
            charging = false,
            plugged = 0,
            keepAliveActive = true,
            wakeLockHeld = true,
            batteryPct = 99,
            temperatureC = 27f,
            currentNowUa = null,
            pulseCount = 12L,
            pulseAgeMs = 3_000L,
            pulseIntervalMs = 10_000L,
            scheduleDelayMs = 8L,
        )
        assertEquals(PowerBankKeepAlive.PowerEvent.Type.DISCONNECTED, event.type)
        assertEquals(false, event.externalPowerPresent)
        assertEquals(true, event.keepAliveActive)
        assertEquals(12L, event.pulseCount)
    }
}
