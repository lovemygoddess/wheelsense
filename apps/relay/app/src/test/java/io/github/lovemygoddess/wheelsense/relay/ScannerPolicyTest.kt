package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScannerPolicyTest {
    @Test
    fun tpmsWildcardUsesZeroMask() {
        val (data, mask) = ScannerPolicy.tpmsWildcardPayload()
        assertArrayEquals(ByteArray(3), data)
        assertArrayEquals(ByteArray(3), mask)
    }

    @Test
    fun failureNamesIncludeApplicationRegistrationFailure() {
        assertTrue(ScannerPolicy.failureName(android.bluetooth.le.ScanCallback.SCAN_FAILED_ALREADY_STARTED).contains("ALREADY_STARTED"))
        assertTrue(ScannerPolicy.failureName(android.bluetooth.le.ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED).contains("APPLICATION_REGISTRATION_FAILED"))
    }

    @Test
    fun identicalPayloadWaitsTenSeconds() {
        assertFalse(ScannerPolicy.shouldCaptureTpms("1E01:010203", 10_000L, "1E01:010203", 19_999L))
        assertTrue(ScannerPolicy.shouldCaptureTpms("1E01:010203", 10_000L, "1E01:010203", 20_000L))
    }

    @Test
    fun changedPayloadHasOneSecondSafetyFloor() {
        assertFalse(ScannerPolicy.shouldCaptureTpms("1E01:010203", 10_000L, "1E01:040506", 10_999L))
        assertTrue(ScannerPolicy.shouldCaptureTpms("1E01:010203", 10_000L, "1E01:040506", 11_000L))
    }
}
