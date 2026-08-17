package io.github.lovemygoddess.wheelsense.relay

/** Pure decoder for the pvvx Custom 0x181A payload used by the ENV sensor. */
internal object EnvPayloadParser {
    data class Decoded(
        val sensorMac: String,
        val tempC: Float,
        val humidityPct: Float,
        val sensorBatteryMv: Int,
    )

    sealed class Outcome {
        data class Success(val value: Decoded) : Outcome()
        data class Failure(val reason: String) : Outcome()
    }

    /** The service-data header is already stripped by ScanRecord. */
    fun decode(data: ByteArray): Outcome {
        if (data.size < 15) return Outcome.Failure("length_${data.size}")
        val mac = (5 downTo 0).joinToString(":") { "%02X".format(data[it].toInt() and 0xFF) }
        val temp = int16Le(data, 6) / 100f
        val humidity = uint16Le(data, 8) / 100f
        val batteryMv = uint16Le(data, 10)
        return Outcome.Success(Decoded(mac, temp, humidity, batteryMv))
    }

    private fun int16Le(bytes: ByteArray, offset: Int): Short =
        ((bytes[offset + 1].toInt() shl 8) or (bytes[offset].toInt() and 0xFF)).toShort()

    private fun uint16Le(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset + 1].toInt() and 0xFF) shl 8) or (bytes[offset].toInt() and 0xFF)
}
