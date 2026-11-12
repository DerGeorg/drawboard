package at.dergeorg.drawboard.collab.infra

import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Limits and times of the collaboration, bound from `collab.*`. The defaults are those of the protocol document
 * (docs/collab-protocol.md in the API repository) and the security decisions S2.5 and S2.7; change them in
 * `application.yaml` or with environment variables (`COLLAB_MAX_LOG_BYTES=...`). Sizes in bytes, times in seconds.
 */
@ConfigurationProperties("collab")
internal data class CollabProperties(
    val maxUpdateBytes: Int = DEFAULTS.maxUpdateBytes,
    val maxAwarenessBytes: Int = DEFAULTS.maxAwarenessBytes,
    val updatesPerSecond: Int = DEFAULTS.updatesPerSecond,
    val updateBurst: Int = DEFAULTS.updateBurst,
    val awarenessPerSecond: Int = DEFAULTS.awarenessPerSecond,
    val awarenessBurst: Int = DEFAULTS.awarenessBurst,
    val maxSessionsPerUser: Int = DEFAULTS.maxSessionsPerUser,
    val maxSessionsPerBoard: Int = DEFAULTS.maxSessionsPerBoard,
    val maxGuestSessionsPerIp: Int = DEFAULTS.maxGuestSessionsPerIp,
    val maxLogBytes: Long = DEFAULTS.maxLogBytes,
    val maxSnapshotBytes: Long = DEFAULTS.maxSnapshotBytes,
    val snapshotBudgetBytes: Long = DEFAULTS.snapshotBudgetBytes,
    val compactionBytes: Long = DEFAULTS.compactionBytes,
    val compactionEntries: Long = DEFAULTS.compactionEntries,
    val compactionRequestSeconds: Long = DEFAULTS.compactionRequestSeconds,
    val compactionMinIntervalSeconds: Long = DEFAULTS.compactionMinIntervalSeconds,
    val idleTimeoutSeconds: Long = DEFAULTS.idleTimeoutSeconds,
    val aclRecheckSeconds: Long = DEFAULTS.aclRecheckSeconds,
    val outboundBuffer: Int = DEFAULTS.outboundBuffer,
    val outboundBytes: Long = DEFAULTS.outboundBytes,
    val snapshotUploadsPerMinute: Long = DEFAULTS.snapshotUploadsPerMinute,
    val snapshotsKept: Int = DEFAULTS.snapshotsKept,
    val snapshotsKeptDays: Long = DEFAULTS.snapshotsKeptDays,
    val ticketSeconds: Long = DEFAULTS.ticketSeconds,
    val ticketsPerMinute: Long = DEFAULTS.ticketsPerMinute,
    /** Seconds between two maintenance passes (expiry, idle, role re-check). */
    val sweepSeconds: Long = 5,
    /** Seconds between two readings of the stored bytes for `drawboard.storage.bytes`. */
    val storageRefreshSeconds: Long = 300,
) {
    fun toLimits() = CollabLimits(
        maxUpdateBytes = maxUpdateBytes,
        maxAwarenessBytes = maxAwarenessBytes,
        updatesPerSecond = updatesPerSecond,
        updateBurst = updateBurst,
        awarenessPerSecond = awarenessPerSecond,
        awarenessBurst = awarenessBurst,
        maxSessionsPerUser = maxSessionsPerUser,
        maxSessionsPerBoard = maxSessionsPerBoard,
        maxGuestSessionsPerIp = maxGuestSessionsPerIp,
        maxLogBytes = maxLogBytes,
        maxSnapshotBytes = maxSnapshotBytes,
        snapshotBudgetBytes = snapshotBudgetBytes,
        compactionBytes = compactionBytes,
        compactionEntries = compactionEntries,
        compactionRequestSeconds = compactionRequestSeconds,
        compactionMinIntervalSeconds = compactionMinIntervalSeconds,
        idleTimeoutSeconds = idleTimeoutSeconds,
        aclRecheckSeconds = aclRecheckSeconds,
        outboundBuffer = outboundBuffer,
        outboundBytes = outboundBytes,
        snapshotUploadsPerMinute = snapshotUploadsPerMinute,
        snapshotsKept = snapshotsKept,
        snapshotsKeptDays = snapshotsKeptDays,
        ticketSeconds = ticketSeconds,
        ticketsPerMinute = ticketsPerMinute,
    )

    private companion object {
        val DEFAULTS = CollabLimits()
    }
}
