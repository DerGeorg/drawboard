package at.dergeorg.drawboard.collab.domain.rooms.model

/**
 * Every limit and time of the collaboration (S2.5, S2.7 and the protocol document), as plain values the domain can
 * read. Filled from the properties `collab.*` (infra); the defaults are those of the specification. Times are in
 * seconds, sizes in bytes.
 */
internal data class CollabLimits(
    val maxUpdateBytes: Int = MIB.toInt(),
    val maxAwarenessBytes: Int = 16_384,
    val updatesPerSecond: Int = 60,
    val updateBurst: Int = 200,
    val awarenessPerSecond: Int = 30,
    val awarenessBurst: Int = 60,
    val maxSessionsPerUser: Int = 20,
    val maxSessionsPerBoard: Int = 200,
    /** Guest sessions from one address (S2.5): guests are cheap to make, so the address is the limit. */
    val maxGuestSessionsPerIp: Int = 50,
    val maxLogBytes: Long = LOG_MIB * MIB,
    val maxSnapshotBytes: Long = SNAPSHOT_MIB * MIB,
    /** Bytes of all kept snapshots of one board (ten maximum-size snapshots by default). */
    val snapshotBudgetBytes: Long = SNAPSHOT_BUDGET_MIB * MIB,
    val compactionBytes: Long = MIB,
    val compactionEntries: Long = 500,
    val compactionRequestSeconds: Long = 120,
    /** Least time between two compaction requests of a board. */
    val compactionMinIntervalSeconds: Long = 60,
    val idleTimeoutSeconds: Long = 300,
    val aclRecheckSeconds: Long = 60,
    val activityThrottleSeconds: Long = 60,
    val violationsBeforeClose: Int = 10,
    val outboundBuffer: Int = 1024,
    /** Bytes a session may have queued for its client; above it the session is closed with 1011. */
    val outboundBytes: Long = OUTBOUND_MIB * MIB,
    val joinSendTimeoutSeconds: Long = 30,
    /** Snapshot uploads a user may start per minute (the upload body is large; this bounds the work it can cause). */
    val snapshotUploadsPerMinute: Long = 10,
    val snapshotsKept: Int = 5,
    val snapshotsKeptDays: Long = 7,
    val ticketSeconds: Long = 30,
    val ticketsPerMinute: Long = 60,
) {
    init {
        require(outboundBuffer > 0 && outboundBytes > 0 && maxUpdateBytes > 0 && maxAwarenessBytes > 0) { "limits must be positive" }
    }
}

private const val MIB = 1_048_576L
private const val LOG_MIB = 100L
private const val SNAPSHOT_MIB = 50L
private const val SNAPSHOT_BUDGET_MIB = 500L
private const val OUTBOUND_MIB = 16L
