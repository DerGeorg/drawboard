package at.dergeorg.drawboard.planning.domain.common

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

class KeyedLocksTest {

    @Test
    fun `when writes use one key then they run one after the other`() = runBlocking {
        val locks = KeyedLocks()
        val key = Uuid.generateV7()
        var inside = 0
        var maxInside = 0

        List(20) {
            async {
                locks.withLock(key) {
                    inside++
                    maxInside = maxOf(maxInside, inside)
                    yield()
                    inside--
                }
            }
        }.awaitAll()

        assertEquals(1, maxInside, "never two at once")
    }

    @Test
    fun `when two instances are used then a held lock of one does not block the other`() = runBlocking {
        val boards = KeyedLocks()
        val sessions = KeyedLocks()
        val key = Uuid.generateV7()

        val result = boards.withLock(key) { sessions.withLock(key) { "both" } }

        assertEquals("both", result, "separate instances, board before session")
    }
}
