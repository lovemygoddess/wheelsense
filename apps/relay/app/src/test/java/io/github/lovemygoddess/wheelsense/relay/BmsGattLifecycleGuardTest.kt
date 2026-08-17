package io.github.lovemygoddess.wheelsense.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BmsGattLifecycleGuardTest {
    @Test
    fun staleGenerationCannotRemainCurrent() {
        val guard = BmsGattLifecycleGuard()
        val first = guard.begin(100L)
        val second = guard.begin(200L)
        assertFalse(guard.isCurrent(first))
        assertTrue(guard.isCurrent(second))
        assertNotEquals(first.generation, second.generation)
    }

    @Test
    fun eachAttemptCanBeClosedOnlyOnce() {
        val guard = BmsGattLifecycleGuard()
        val attempt = guard.begin(100L)
        assertTrue(guard.markClosed(attempt))
        assertFalse(guard.markClosed(attempt))
    }

    @Test
    fun invalidateBlocksOldCallback() {
        val guard = BmsGattLifecycleGuard()
        val attempt = guard.begin(100L)
        guard.invalidate()
        assertFalse(guard.isCurrent(attempt))
        assertNull(guard.activeGeneration())
    }
}
