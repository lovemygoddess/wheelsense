package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BmsReconnectPolicyTest {
    @Test
    fun validMacIsRequiredForDirectReconnect() {
        assertTrue(BmsReconnectPolicy.isValidMac("AA:BB:CC:DD:EE:FF"))
        assertFalse(BmsReconnectPolicy.isValidMac(null))
        assertFalse(BmsReconnectPolicy.isValidMac("AA:BB:CC:DD:EE"))
        assertFalse(BmsReconnectPolicy.isValidMac("not-a-mac"))
    }

    @Test
    fun diagnosticsScrubCompleteMacAddresses() {
        val text = BmsReconnectPolicy.scrubMacs("连接 AA:BB:CC:DD:EE:FF RSSI=-70")
        assertFalse(text.contains("AA:BB:CC:DD:EE:FF"))
        assertTrue(text.contains("…EEFF"))
    }

    @Test
    fun backoffIsBoundedAndExponential() {
        var value = BmsReconnectPolicy.MIN_BACKOFF_MS
        val values = mutableListOf<Long>()
        repeat(6) {
            values += value
            value = BmsReconnectPolicy.nextBackoffMs(value)
        }
        assertTrue(values == listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L, 60_000L))
        assertTrue(BmsReconnectPolicy.nextBackoffMs(60_000L) == 60_000L)
    }

    @Test
    fun directReconnectDoesNotRequireScanResult() {
        assertTrue(
            BmsReconnectPolicy.canStartDirect(
                savedMac = "AA:BB:CC:DD:EE:FF",
                phase = BmsConnectPhase.IDLE,
                nowElapsedMs = 10_000L,
                lastAttemptElapsedMs = 0L,
                minSpacingMs = 60_000L,
            )
        )
    }

    @Test
    fun activeGattStatesBlockSecondAttempt() {
        for (phase in listOf(
            BmsConnectPhase.CONNECTING,
            BmsConnectPhase.CONNECTED,
            BmsConnectPhase.DISCOVERING_SERVICES,
        )) {
            assertFalse(
                BmsReconnectPolicy.canStartDirect(
                    "AA:BB:CC:DD:EE:FF", phase, 10_000L, 0L, 60_000L,
                )
            )
        }
    }

    @Test
    fun spacingBlocksTightLoopButAllowsNextAttempt() {
        assertFalse(
            BmsReconnectPolicy.canStartDirect(
                "AA:BB:CC:DD:EE:FF", BmsConnectPhase.BACKOFF,
                nowElapsedMs = 59_999L, lastAttemptElapsedMs = 10_000L, minSpacingMs = 60_000L,
            )
        )
        assertTrue(
            BmsReconnectPolicy.canStartDirect(
                "AA:BB:CC:DD:EE:FF", BmsConnectPhase.BACKOFF,
                nowElapsedMs = 70_000L, lastAttemptElapsedMs = 10_000L, minSpacingMs = 60_000L,
            )
        )
    }
}
