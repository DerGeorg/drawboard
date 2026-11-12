package at.dergeorg.drawboard.collab.domain.storage.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the snapshot events. Rules: the logical name never changes; a new field needs a default; a change of
// meaning gets a new name (.v2). Who stored it (the actor) is added by the auditing module.

/**
 * A client uploaded the snapshot the server asked for (S7.1: "compaction (who, sizes)"): the sequence number it covers,
 * its size, and what the retention removed because of it.
 */
@AuditDetails(type = "collab.snapshot-stored")
data class SnapshotStored(
    val upToSeq: Long,
    val sizeBytes: Long,
    val snapshotsDeleted: Int = 0,
    val logDroppedUpToSeq: Long = 0,
) : DomainEventDetails

/**
 * The owner restored a version (S7.1 "version restored"): [versionId] is the chosen snapshot, [restoredUpToSeq] the log
 * position it covered, [newBaseSeq] the sequence number of the new base snapshot (a new epoch above everything before).
 */
@AuditDetails(type = "collab.version-restored")
data class VersionRestored(val versionId: String, val restoredUpToSeq: Long, val newBaseSeq: Long) : DomainEventDetails
