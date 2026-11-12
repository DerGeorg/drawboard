package at.dergeorg.drawboard.collab.domain.storage

import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.uuid.Uuid

class RetentionTest {

    private fun snapshot(upToSeq: Long, age: Duration) =
        SnapshotMeta(Uuid.generateV7(), upToSeq, size = 10, createdAt = FIXED_NOW - age)

    private fun plan(vararg snapshots: SnapshotMeta) = Retention.plan(snapshots.toList(), FIXED_NOW, keepLast = 5, keepFor = 7.days)

    @Test
    fun `when there are fewer snapshots than the last five then all are kept and the log is dropped up to the oldest`() {
        val result = plan(snapshot(100, 1.hours), snapshot(300, 0.hours))

        assertEquals(emptyList(), result.deleteSnapshots, "nothing to delete")
        assertEquals(100, result.dropLogUpTo, "log before the oldest kept snapshot is contained in it")
    }

    @Test
    fun `when old snapshots exceed the last five then they are deleted, and the log up to the oldest kept goes with them`() {
        val old = (1..3).map { snapshot(it * 100L, 30.days) }
        val recent = (4..8).map { snapshot(it * 100L, 30.days) } // also old, but the five newest

        val result = Retention.plan(old + recent, FIXED_NOW, keepLast = 5, keepFor = 7.days)

        assertEquals(old.map { it.id }.toSet(), result.deleteSnapshots.toSet(), "the three oldest beyond five")
        assertEquals(400, result.dropLogUpTo, "oldest kept is the 4th")
    }

    @Test
    fun `when more than five snapshots are younger than seven days then all of them are kept - whichever is more`() {
        val snapshots = (1..8).map { snapshot(it * 100L, it.hours) }

        val result = Retention.plan(snapshots, FIXED_NOW, keepLast = 5, keepFor = 7.days)

        assertEquals(emptyList(), result.deleteSnapshots, "all eight are from the last week")
        assertEquals(100, result.dropLogUpTo, "oldest kept")
    }

    @Test
    fun `when the young snapshots exceed the byte budget then the older ones beyond it are deleted`() {
        // eight snapshots of 100 bytes from the last week, newest = highest seq; budget 700 bytes
        val snapshots = (1..8).map { SnapshotMeta(Uuid.generateV7(), it * 100L, size = 100, createdAt = FIXED_NOW - it.hours) }

        val result = Retention.plan(snapshots, FIXED_NOW, keepLast = 5, keepFor = 7.days, maxBytes = 700)

        assertEquals(1, result.deleteSnapshots.size, "seven fit into 700 bytes, the eighth does not")
        assertEquals(snapshots.single { it.upToSeq == 100L }.id, result.deleteSnapshots.single(), "the oldest goes")
        assertEquals(200, result.dropLogUpTo, "log kept from the oldest kept snapshot")
    }

    @Test
    fun `when the budget is smaller than the newest five then those five are still kept`() {
        val snapshots = (1..8).map { SnapshotMeta(Uuid.generateV7(), it * 100L, size = 100, createdAt = FIXED_NOW - it.hours) }

        val result = Retention.plan(snapshots, FIXED_NOW, keepLast = 5, keepFor = 7.days, maxBytes = 10)

        assertEquals(3, result.deleteSnapshots.size, "everything beyond the newest five")
        assertEquals(400, result.dropLogUpTo, "the fifth newest is the oldest kept")
    }

    @Test
    fun `when an old snapshot is small but a newer one broke the budget then it is not kept either`() {
        val big = SnapshotMeta(Uuid.generateV7(), 300, size = 900, createdAt = FIXED_NOW - 2.hours)
        val small = SnapshotMeta(Uuid.generateV7(), 200, size = 1, createdAt = FIXED_NOW - 3.hours)
        val newest = SnapshotMeta(Uuid.generateV7(), 400, size = 10, createdAt = FIXED_NOW)

        val result = Retention.plan(listOf(newest, big, small), FIXED_NOW, keepLast = 1, keepFor = 7.days, maxBytes = 500)

        assertEquals(setOf(big.id, small.id), result.deleteSnapshots.toSet(), "the budget does not skip over a broken link")
        assertEquals(400, result.dropLogUpTo, "only the newest is kept")
    }
}
