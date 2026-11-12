package at.dergeorg.drawboard.collab.domain

import at.dergeorg.drawboard.collab.common.CollabModule
import at.dergeorg.drawboard.collab.domain.ratelimit.UserRateLimiter
import at.dergeorg.drawboard.collab.domain.rooms.CollabMetrics
import at.dergeorg.drawboard.collab.domain.rooms.RoomRegistry
import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import at.dergeorg.drawboard.collab.domain.rooms.model.RejectionReason
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabConnection
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.StoreSnapshotCommand
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.collab.domain.storage.Retention
import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotStored
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import at.dergeorg.drawboard.collab.domain.storage.requires.SnapshotStore
import at.dergeorg.drawboard.collab.domain.storage.requires.UpdateLog
import at.dergeorg.drawboard.collab.domain.tickets.TicketRegistry
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssuedTicket
import at.dergeorg.drawboard.collab.domain.tickets.provides.TicketsUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.RestoreVersionCommand
import at.dergeorg.drawboard.collab.domain.rooms.provides.VersionView
import at.dergeorg.drawboard.collab.domain.storage.model.VersionRestored
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.time.Duration.Companion.days
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements every use case of the collab module. The transaction boundary: a snapshot, the retention it triggers and
 * the log it replaces are written in one transaction - both or neither.
 *
 * Tickets and rooms are in the memory of this process: one replica (see [CollabUseCase]).
 */
@Service
internal class CollabService(
    private val tickets: TicketRegistry,
    private val rooms: RoomRegistry,
    private val access: BoardAccess,
    private val log: UpdateLog,
    private val snapshots: SnapshotStore,
    private val limits: CollabLimits,
    private val clock: Clock,
    private val audit: AuditTrail,
    private val metrics: CollabMetrics,
) : TicketsUseCase, CollabUseCase {

    private val uploads = UserRateLimiter(limits.snapshotUploadsPerMinute, clock)

    private val events = DomainEvents(CollabModule.NAME)

    @WithSpan
    override suspend fun issue(command: IssueTicketCommand): IssuedTicket = tickets.issue(command)

    @WithSpan
    override suspend fun admit(ticket: String, @SpanAttribute("board.id") boardId: Uuid, clientAddress: String?): Admission {
        val claims = tickets.redeem(ticket, boardId) ?: return Admission.Rejected(RejectionReason.UNKNOWN_TICKET)
        if (rooms.isReplacing(boardId)) return Admission.Rejected(RejectionReason.BOARD_BUSY)
        // The role is resolved again: it may have changed since the ticket was issued (S2.2).
        val who = Participant(claims.userId, claims.groups, claims.shareId)
        val role = access.roleOf(boardId, who) ?: return Admission.Rejected(RejectionReason.NO_ACCESS)
        val guestAddress = clientAddress.takeIf { who.guest }
        if (rooms.sessionLimitReached(boardId, claims.userId, guestAddress)) return Admission.Rejected(RejectionReason.TOO_MANY_SESSIONS)
        return Admission.Admitted(
            boardId, claims.userId, claims.displayName, claims.tokenExpiresAt, role, claims.groups, claims.shareId, guestAddress,
        )
    }

    @WithSpan
    override suspend fun open(admitted: Admission.Admitted): CollabConnection = rooms.open(admitted)

    @WithSpan
    override suspend fun checkSnapshotUpload(userId: Uuid, boardId: Uuid, upToSeq: Long) {
        uploads.take(userId)
        rooms.requireCompactionRequest(boardId, userId, upToSeq)
    }

    @WithSpan
    @Transactional
    override suspend fun storeSnapshot(command: StoreSnapshotCommand) {
        if (command.data.isEmpty()) {
            throw ValidationFailedException(listOf(InvalidField("snapshot", "NotEmpty", "must not be empty")))
        }
        if (command.data.size > limits.maxSnapshotBytes) throw PayloadTooLargeException(limits.maxSnapshotBytes)
        val now = clock.now()
        requireRoomForSnapshot(command, now)
        rooms.takeCompactionRequest(command.boardId, command.userId, command.upToSeq)
        snapshots.insert(StoredSnapshot(command.boardId, command.upToSeq, command.data, command.userId, now))
        val plan = retentionPlan(snapshots.listMeta(command.boardId), now)
        snapshots.delete(plan.deleteSnapshots)
        log.deleteUpTo(command.boardId, plan.dropLogUpTo)
        val details = SnapshotStored(command.upToSeq, command.data.size.toLong(), plan.deleteSnapshots.size, plan.dropLogUpTo)
        audit.record(events.of(SNAPSHOT, command.boardId, AuditAction.CREATED, "stored", details))
        rooms.snapshotStored(command.boardId, command.upToSeq)
    }

    private fun retentionPlan(metas: List<SnapshotMeta>, now: Instant) =
        Retention.plan(metas, now, limits.snapshotsKept, limits.snapshotsKeptDays.days, limits.snapshotBudgetBytes)

    /**
     * The kept snapshots of a board have a byte budget of their own (S2.7), separate from the log's limit
     * [CollabLimits.maxLogBytes]: 413 if, after this upload and the retention it triggers, the kept snapshots would be
     * above [CollabLimits.snapshotBudgetBytes]. The retention already drops old snapshots to stay within the budget, so
     * this only fails when the newest snapshots that are always kept are too large together.
     */
    private suspend fun requireRoomForSnapshot(command: StoreSnapshotCommand, now: Instant) {
        val incoming = SnapshotMeta(Uuid.generateV7(), command.upToSeq, command.data.size, now)
        val existing = snapshots.listMeta(command.boardId)
        val plan = retentionPlan(existing + incoming, now)
        val keptBytes = (existing + incoming).filter { it.id !in plan.deleteSnapshots }.sumOf { it.size.toLong() }
        if (keptBytes > limits.snapshotBudgetBytes) {
            throw PayloadTooLargeException(limits.snapshotBudgetBytes)
        }
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listVersions(@SpanAttribute("board.id") boardId: Uuid): List<VersionView> =
        snapshots.listMeta(boardId).map { VersionView(it.id, it.upToSeq, it.createdAt, it.size.toLong()) }

    @WithSpan
    @Transactional
    override suspend fun restoreVersion(command: RestoreVersionCommand) {
        val chosen = snapshots.findById(command.boardId, command.versionId) ?: throw DomainException(
            ErrorCode.COLLAB_VERSION_NOT_FOUND,
            mapOf("boardId" to command.boardId.toString(), "versionId" to command.versionId.toString()),
        )
        // Everything that exists lies below the new base: a new epoch of sequence numbers. The log is dropped - it
        // describes the document that is replaced; the chosen snapshot stays what it was.
        val head = maxOf(snapshots.findLatest(command.boardId)?.upToSeq ?: 0, log.lastSeq(command.boardId) ?: 0)
        val base = head + 1
        snapshots.insert(StoredSnapshot(command.boardId, base, chosen.data, command.userId, clock.now()))
        log.deleteAll(command.boardId)
        val details = VersionRestored(command.versionId.toString(), chosen.upToSeq, base)
        audit.record(events.of(SNAPSHOT, command.boardId, AuditAction.EXECUTED, "restored", details))
    }

    @WithSpan
    override suspend fun beginReplace(@SpanAttribute("board.id") boardId: Uuid) = rooms.beginReplace(boardId)

    @WithSpan
    override suspend fun endReplace(@SpanAttribute("board.id") boardId: Uuid) = rooms.endReplace(boardId)

    @WithSpan
    override suspend fun closeSessions(@SpanAttribute("board.id") boardId: Uuid) =
        rooms.closeRoom(boardId, RoomRegistry.CLOSE_BOARD_DELETED, "board in the trash")

    @WithSpan
    override suspend fun recheckAll() = rooms.recheckAll()

    @WithSpan
    @Transactional
    override suspend fun deleteBoardData(@SpanAttribute("board.id") boardId: Uuid) {
        rooms.closeRoom(boardId, RoomRegistry.CLOSE_BOARD_DELETED, "board deleted")
        log.deleteAll(boardId)
        snapshots.deleteAll(boardId)
    }

    /** One maintenance pass (token expiry, idle, role re-check); called by the scheduler in infra. */
    @WithSpan
    suspend fun sweep() = rooms.sweep()

    /** Reads the bytes held in the database for the gauge `drawboard.storage.bytes` (S2.7: alert on it). */
    @WithSpan
    suspend fun refreshStorageMetrics() {
        metrics.storageBytes("snapshot", snapshots.totalSize())
        metrics.storageBytes("log", log.totalSize())
    }

    /** The application stops: sessions get 1001. */
    @WithSpan
    suspend fun shutdown() = rooms.closeAll()

    private companion object {
        const val SNAPSHOT = "snapshot"
    }
}
