package at.dergeorg.drawboard.collab.domain.rooms

import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** The server asked [userId] (session [sessionId]) for a snapshot up to [upToSeq]; open until [expiresAt]. */
internal data class CompactionRequest(val sessionId: Uuid, val userId: Uuid, val upToSeq: Long, val expiresAt: Instant)

/**
 * Everything the server knows about one open board: its sessions and the counters that decide about sequence
 * numbers, limits and compaction. Lives in memory while at least one session is open.
 *
 * The properties below `mutex` are guarded by it: sequence numbers are assigned, appended to the log and broadcast
 * under this lock, so every session sees the updates of a board in the order of their `seq`. One replica only -
 * with several, two rooms of the same board would hand out the same `seq` (the unique key would reject one).
 */
internal class Room(
    val boardId: Uuid,
    var headSeq: Long,
    var snapshotUpToSeq: Long,
    var logBytes: Long,
    var sinceSnapshotBytes: Long,
    var sinceSnapshotEntries: Long,
) {
    val mutex = Mutex()

    /** Added and removed under the registry's lock; iterated by broadcasts under [mutex]. */
    val sessions = ConcurrentHashMap<Uuid, Session>()

    var compaction: CompactionRequest? = null

    /** The session the last request went to, so a repeated request tries another client first. */
    var lastCompactionTarget: Uuid? = null

    /** When the last compaction was requested; the next one waits for the minimum interval. */
    var lastCompactionAt: Instant = Instant.DISTANT_PAST

    var lastActivityReport: Instant = Instant.DISTANT_PAST
}
