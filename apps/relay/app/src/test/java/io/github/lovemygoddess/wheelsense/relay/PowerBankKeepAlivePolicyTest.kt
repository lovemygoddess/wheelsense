package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PowerBankKeepAlivePolicyTest {
    private fun input(
        enabled: Boolean = true,
        running: Boolean = true,
        external: Boolean = true,
        battery: Int? = 98,
        temp: Float? = 30f,
    ) = KeepAliveInput(enabled, running, external, battery, temp)

    @Test
    fun highBatteryAndExternalPowerStartsKeepAlive() {
        val decision = PowerBankKeepAlivePolicy().evaluate(input())
        assertTrue(decision.active)
        assertEquals(null, decision.stopReason)
    }

    @Test
    fun batteryHysteresisStopsAt94AndDoesNotRestartAt96() {
        val policy = PowerBankKeepAlivePolicy()
        assertTrue(policy.evaluate(input(battery = 98)).active)
        assertFalse(policy.evaluate(input(battery = 94)).active)
        assertEquals(KeepAliveStopReason.BATTERY_BELOW_THRESHOLD, policy.evaluate(input(battery = 96)).stopReason)
        assertTrue(policy.evaluate(input(battery = 97)).active)
    }

    @Test
    fun overTemperatureStopsAndOnlyRecoversAt36() {
        val policy = PowerBankKeepAlivePolicy()
        assertTrue(policy.evaluate(input()).active)
        assertFalse(policy.evaluate(input(temp = 38f)).active)
        assertFalse(policy.evaluate(input(temp = 37f)).active)
        assertTrue(policy.evaluate(input(temp = 36f)).active)
    }

    @Test
    fun externalPowerLossAlwaysWinsAndCannotPulse() {
        val policy = PowerBankKeepAlivePolicy()
        assertTrue(policy.evaluate(input()).active)
        val decision = policy.evaluate(input(external = false))
        assertFalse(decision.active)
        assertEquals(KeepAliveStopReason.EXTERNAL_POWER_LOST, decision.stopReason)
    }

    @Test
    fun disabledAndStoppedServiceFailClosed() {
        val policy = PowerBankKeepAlivePolicy()
        assertEquals(KeepAliveStopReason.DISABLED, policy.evaluate(input(enabled = false)).stopReason)
        assertEquals(KeepAliveStopReason.SERVICE_STOPPED, policy.evaluate(input(running = false)).stopReason)
    }

    @Test
    fun missingBatteryValuesNeverStart() {
        val policy = PowerBankKeepAlivePolicy()
        assertFalse(policy.evaluate(input(battery = null)).active)
        assertFalse(policy.evaluate(input(temp = null)).active)
    }
}
