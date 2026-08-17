package io.github.lovemygoddess.wheelsense.relay

/**
 * Small, platform-free decisions used by the known-board reconnect path.
 * Keeping these rules outside BleManager makes the safety properties easy to
 * exercise without a Bluetooth adapter or a physical relay phone.
 */
enum class BmsConnectSource(val wireName: String) {
    DIRECT_SAVED_MAC("DIRECT_SAVED_MAC"),
    SCAN_KNOWN_MAC("SCAN_KNOWN_MAC"),
    SCAN_DISCOVERY("SCAN_DISCOVERY"),
}

enum class BmsConnectPhase(val wireName: String) {
    IDLE("IDLE"),
    CONNECTING("CONNECTING"),
    CONNECTED("CONNECTED"),
    DISCOVERING_SERVICES("DISCOVERING_SERVICES"),
    BACKOFF("BACKOFF"),
}

object BmsReconnectPolicy {
    const val MIN_BACKOFF_MS = 5_000L
    const val MAX_BACKOFF_MS = 60_000L

    private val MAC_PATTERN = Regex("(?i)^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")
    private val MAC_FIND_PATTERN = Regex("(?i)(?:[0-9a-f]{2}:){5}[0-9a-f]{2}")

    fun isValidMac(value: String?): Boolean =
        value != null && MAC_PATTERN.matches(value)

    /** Redact a MAC for any human-readable diagnostics or notifications. */
    fun maskMac(value: String?): String = if (isValidMac(value)) {
        "…${value!!.replace(":", "").takeLast(4)}"
    } else {
        value ?: "-"
    }

    /** Replace every colon-form MAC in a status string, not just the BMS one. */
    fun scrubMacs(value: String): String =
        value.replace(MAC_FIND_PATTERN) { match -> maskMac(match.value) }

    /** 5s → 10s → 20s → 40s → 60s, then remain capped. */
    fun nextBackoffMs(currentMs: Long): Long = when {
        currentMs <= 0L -> MIN_BACKOFF_MS
        else -> (currentMs * 2L).coerceAtMost(MAX_BACKOFF_MS)
    }

    /** Never start a second GATT attempt, and never reconnect without identity. */
    fun canStartDirect(
        savedMac: String?,
        phase: BmsConnectPhase,
        nowElapsedMs: Long,
        lastAttemptElapsedMs: Long,
        minSpacingMs: Long,
    ): Boolean {
        if (!isValidMac(savedMac)) return false
        if (phase == BmsConnectPhase.CONNECTING || phase == BmsConnectPhase.CONNECTED ||
            phase == BmsConnectPhase.DISCOVERING_SERVICES
        ) return false
        if (lastAttemptElapsedMs > 0L && nowElapsedMs - lastAttemptElapsedMs < minSpacingMs) {
            return false
        }
        return true
    }
}
