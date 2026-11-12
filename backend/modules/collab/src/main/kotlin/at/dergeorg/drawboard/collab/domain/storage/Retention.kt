package at.dergeorg.drawboard.collab.domain.storage

import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import kotlin.time.Duration
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** What to delete after a snapshot was stored: these snapshots, and the log entries with `seq <= dropLogUpTo`. */
internal data class RetentionPlan(val deleteSnapshots: List<Uuid>, val dropLogUpTo: Long)

/**
 * "Keep the last [keepLast] snapshots or all of the last [keepFor], whichever is more" (S2.8), bounded by a byte budget
 * per board: the newest [keepLast] are always kept, an older one only while it is young enough AND the kept snapshots
 * (newest first, this one included) stay within `maxBytes`. Without the budget every snapshot of a week would stay
 * and a client that is asked for snapshots often could fill the disk. The log is kept from the oldest kept snapshot
 * on: everything up to its `upToSeq` is contained in it.
 */
internal object Retention {

    /** [snapshots] of one board, in any order; must not be empty (a snapshot was just stored). */
    fun plan(
        snapshots: List<SnapshotMeta>,
        now: Instant,
        keepLast: Int,
        keepFor: Duration,
        maxBytes: Long = Long.MAX_VALUE,
    ): RetentionPlan {
        val newestFirst = snapshots.sortedByDescending { it.upToSeq }
        val keep = ArrayList<SnapshotMeta>()
        var bytes = 0L
        var budgetHolds = true
        for ((index, snapshot) in newestFirst.withIndex()) {
            bytes += snapshot.size
            val mandatory = index < keepLast
            budgetHolds = budgetHolds && (mandatory || bytes <= maxBytes)
            if (mandatory || (budgetHolds && now - snapshot.createdAt <= keepFor)) keep += snapshot
        }
        val kept = keep.map { it.id }.toSet()
        return RetentionPlan(
            deleteSnapshots = newestFirst.filter { it.id !in kept }.map { it.id },
            dropLogUpTo = keep.minOf { it.upToSeq },
        )
    }
}
