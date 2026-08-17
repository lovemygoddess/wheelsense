package io.github.lovemygoddess.wheelsense.relay

/**
 * Platform-free generation/close guard for the BMS GATT lifecycle.
 *
 * Android can deliver callbacks from a BluetoothGatt after a newer attempt has
 * already replaced it. Only the active generation may mutate connection state;
 * every generation is closed at most once.
 */
internal data class BmsGattAttempt(
    val generation: Long,
    val openedAtElapsedMs: Long,
)

internal class BmsGattLifecycleGuard {
    private var nextGeneration = 0L
    private var activeGeneration: Long? = null
    private val closedGenerations = mutableSetOf<Long>()

    fun begin(openedAtElapsedMs: Long): BmsGattAttempt {
        val attempt = BmsGattAttempt(++nextGeneration, openedAtElapsedMs)
        activeGeneration = attempt.generation
        return attempt
    }

    fun invalidate() {
        activeGeneration = null
    }

    fun isCurrent(attempt: BmsGattAttempt): Boolean = activeGeneration == attempt.generation

    /** Returns true exactly once for an attempt. */
    fun markClosed(attempt: BmsGattAttempt): Boolean = closedGenerations.add(attempt.generation)

    fun activeGeneration(): Long? = activeGeneration
}
