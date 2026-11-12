package at.dergeorg.drawboard.collab.infra

import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class CollabPropertiesTest {

    @Test
    fun `when nothing is configured then the limits are those of the protocol document`() {
        val limits = CollabProperties().toLimits()

        assertEquals(CollabLimits(), limits, "defaults")
        assertEquals(
            listOf(1_048_576, 16_384, 60, 200, 30, 20, 200),
            listOf(
                limits.maxUpdateBytes, limits.maxAwarenessBytes, limits.updatesPerSecond, limits.updateBurst,
                limits.awarenessPerSecond, limits.maxSessionsPerUser, limits.maxSessionsPerBoard,
            ),
            "S2.5",
        )
        assertEquals(listOf(100L * 1_048_576, 50L * 1_048_576), listOf(limits.maxLogBytes, limits.maxSnapshotBytes), "S2.7")
        assertEquals(
            listOf(1_048_576L, 500L, 120L, 300L),
            listOf(limits.compactionBytes, limits.compactionEntries, limits.compactionRequestSeconds, limits.idleTimeoutSeconds),
            "compaction and idle",
        )
    }

    @Test
    fun `when a value is configured then it reaches the limits`() {
        assertEquals(7, CollabProperties(maxSessionsPerUser = 7).toLimits().maxSessionsPerUser, "override")
    }
}
