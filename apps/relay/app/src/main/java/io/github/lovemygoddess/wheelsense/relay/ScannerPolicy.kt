package io.github.lovemygoddess.wheelsense.relay

import android.bluetooth.le.ScanCallback

/** Pure scanner policy decisions shared by the Android scanner and JVM tests. */
object ScannerPolicy {
    const val BACKGROUND_FILTERED = "BACKGROUND_FILTERED"
    const val DISCOVERY_UNFILTERED = "DISCOVERY_UNFILTERED"
    const val TPMS_MANUFACTURER_ID = 0x1E01
    const val TPMS_PAYLOAD_LENGTH = 3

    /** A zero mask means no payload bit participates in the match. */
    fun tpmsWildcardPayload(length: Int = TPMS_PAYLOAD_LENGTH): Pair<ByteArray, ByteArray> {
        require(length > 0) { "manufacturer payload length must be positive" }
        return ByteArray(length) to ByteArray(length)
    }

    fun failureName(code: Int): String = when (code) {
        ScanCallback.SCAN_FAILED_ALREADY_STARTED -> "SCAN_FAILED_ALREADY_STARTED"
        ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED ->
            "SCAN_FAILED_APPLICATION_REGISTRATION_FAILED"
        ScanCallback.SCAN_FAILED_INTERNAL_ERROR -> "SCAN_FAILED_INTERNAL_ERROR"
        ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED -> "SCAN_FAILED_FEATURE_UNSUPPORTED"
        ScanCallback.SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES ->
            "SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES"
        ScanCallback.SCAN_FAILED_SCANNING_TOO_FREQUENTLY ->
            "SCAN_FAILED_SCANNING_TOO_FREQUENTLY"
        else -> "UNKNOWN_SCAN_FAILURE"
    }

    /** Same payloads are de-duplicated; changed payloads get a short safety floor. */
    fun shouldCaptureTpms(
        lastPayload: String?,
        lastCapturedAtMs: Long,
        payload: String,
        nowMs: Long,
        samePayloadIntervalMs: Long = 10_000L,
        changedPayloadIntervalMs: Long = 1_000L,
    ): Boolean {
        if (lastPayload == null || lastCapturedAtMs <= 0L) return true
        val elapsed = (nowMs - lastCapturedAtMs).coerceAtLeast(0L)
        val floor = if (lastPayload == payload) samePayloadIntervalMs else changedPayloadIntervalMs
        return elapsed >= floor
    }
}
