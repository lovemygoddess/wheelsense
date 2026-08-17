package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EnvPayloadParserTest {
    @Test
    fun decodesCustomPayloadAndReversesEmbeddedMac() {
        val payload = ByteArray(15)
        // Printed MAC AA:BB:CC:DD:EE:FF is little-endian in bytes 0..5.
        byteArrayOf(0xFF.toByte(), 0xEE.toByte(), 0xDD.toByte(), 0xCC.toByte(), 0xBB.toByte(), 0xAA.toByte())
            .copyInto(payload, 0)
        payload[6] = 0x82.toByte() // -11.50 C, little-endian 0xFB82
        payload[7] = 0xFB.toByte()
        payload[8] = 0x10
        payload[9] = 0x27 // 100.00 %RH
        payload[10] = 0x88.toByte()
        payload[11] = 0x13 // 5000 mV

        val outcome = EnvPayloadParser.decode(payload)
        assertTrue(outcome is EnvPayloadParser.Outcome.Success)
        val decoded = (outcome as EnvPayloadParser.Outcome.Success).value
        assertEquals("AA:BB:CC:DD:EE:FF", decoded.sensorMac)
        assertEquals(-11.5f, decoded.tempC, 0.001f)
        assertEquals(100f, decoded.humidityPct, 0.001f)
        assertEquals(5000, decoded.sensorBatteryMv)
    }

    @Test
    fun reportsLengthFailureInsteadOfReturningUnexplainedNull() {
        val outcome = EnvPayloadParser.decode(ByteArray(13))
        assertEquals(EnvPayloadParser.Outcome.Failure("length_13"), outcome)
    }
}
