package at.dergeorg.drawboard.collab.domain

import kotlin.test.assertContentEquals
import at.dergeorg.drawboard.collab.domain.storage.model.VersionRestored
import at.dergeorg.drawboard.collab.domain.rooms.provides.RestoreVersionCommand
import at.dergeorg.drawboard.collab.domain.rooms.RoomRegistry
import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.rooms.model.RejectionReason
import at.dergeorg.drawboard.collab.domain.rooms.provides.StoreSnapshotCommand
import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import at.dergeorg.drawboard.collab.domain.tickets.TicketRegistry
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotStored
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.uuid.Uuid

@OptIn(ExperimentalCoroutinesApi::class)
class CollabServiceTest {

    private val clock = MutableClock()
    private val log = InMemoryUpdateLog()
    private val snapshots = InMemorySnapshotStore()
    private val access = FakeBoardAccess()
    private val audit = RecordingAuditTrail()
    private val metrics = RecordingCollabMetrics()
    private val board = Uuid.random()
    private val alice = Uuid.random()
    private val limits = CollabLimits(compactionEntries = 2, snapshotsKept = 1, snapshotsKeptDays = 1)

    private fun TestScope.service(limits: CollabLimits = this@CollabServiceTest.limits): CollabService {
        val rooms = RoomRegistry(
            log, snapshots, access, RecordingBoardActivity(), limits, clock, RecordingAppLogger(),
            CoroutineScope(UnconfinedTestDispatcher(testScheduler) + SupervisorJob()), metrics,
        )
        return CollabService(TicketRegistry(limits, clock), rooms, access, log, snapshots, limits, clock, audit, metrics)
    }

    private fun ticketFor(service: CollabService, user: Uuid = alice) = kotlinx.coroutines.runBlocking {
        service.issue(IssueTicketCommand(user, board, "Alice", FIXED_NOW + 1.hours)).ticket
    }

    @Nested
    inner class Admit {

        @Test
        fun `when admitting a valid ticket of a user with a role then the handshake is admitted with the fresh role`() = runTest {
            val service = service()
            access.roles[board to alice] = CollabRole.COMMENTER

            val admission = service.admit(ticketFor(service), board)

            val admitted = assertIs<Admission.Admitted>(admission, "admitted")
            assertEquals(CollabRole.COMMENTER, admitted.role, "role resolved again, not taken from the ticket")
            assertEquals(FIXED_NOW + 1.hours, admitted.tokenExpiresAt, "token expiry travels with the ticket")
        }

        @Test
        fun `when admitting a used unknown or foreign ticket then it is UNKNOWN_TICKET`() = runTest {
            val service = service()
            access.roles[board to alice] = CollabRole.EDITOR
            val ticket = ticketFor(service)

            service.admit(ticket, board)

            assertEquals(Admission.Rejected(RejectionReason.UNKNOWN_TICKET), service.admit(ticket, board), "used")
            assertEquals(Admission.Rejected(RejectionReason.UNKNOWN_TICKET), service.admit("x".repeat(43), board), "unknown")
            val otherBoard = service.admit(ticketFor(service), Uuid.random())
            assertEquals(Admission.Rejected(RejectionReason.UNKNOWN_TICKET), otherBoard, "other board")
        }

        @Test
        fun `when the user lost the role since the ticket was issued then NO_ACCESS`() = runTest {
            val service = service()

            assertEquals(Admission.Rejected(RejectionReason.NO_ACCESS), service.admit(ticketFor(service), board), "no role")
        }

        @Test
        fun `when the user already has the maximum of sessions then TOO_MANY_SESSIONS`() = runTest {
            val service = service(limits.copy(maxSessionsPerUser = 1))
            access.roles[board to alice] = CollabRole.EDITOR
            service.open(assertIs<Admission.Admitted>(service.admit(ticketFor(service), board), "first"))

            assertEquals(Admission.Rejected(RejectionReason.TOO_MANY_SESSIONS), service.admit(ticketFor(service), board), "second")
        }
    }

    @Nested
    inner class StoreSnapshot {

        private suspend fun CollabService.askForSnapshot(): Long {
            access.roles[board to alice] = CollabRole.EDITOR
            val connection = open(assertIs<Admission.Admitted>(admit(ticketFor(this), board), "admitted"))
            repeat(3) { connection.onBinary(byteArrayOf(0x01, it.toByte())) }
            return log.entries.maxOf { it.seq }
        }

        @Test
        fun `when the asked user uploads then the snapshot is stored and the log up to it is dropped`() = runTest {
            val service = service()
            val upTo = service.askForSnapshot()

            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1, 2, 3)))

            assertEquals(listOf(upTo), snapshots.snapshots.map { it.second.upToSeq }, "stored")
            assertTrue(log.entries.isEmpty(), "log up to the only (oldest kept) snapshot is dropped")
        }

        @Test
        fun `when a snapshot is stored then the compaction is audited with its seq, size and what the retention removed`() = runTest {
            val service = service()
            val upTo = service.askForSnapshot()

            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1, 2, 3)))

            val event = audit.events.single()
            assertEquals("collab.snapshot.stored", event.eventType, "event type")
            assertEquals(board.toString(), event.entityId, "the board is the audited entity")
            assertEquals(AuditAction.CREATED, event.action, "action")
            val details = SnapshotStored(upToSeq = upTo, sizeBytes = 3, snapshotsDeleted = 0, logDroppedUpToSeq = upTo)
            assertEquals(details, event.details, "details")
        }

        @Test
        fun `when nobody asked or the seq is another one then COLLAB_SNAPSHOT_NOT_REQUESTED and nothing is stored`() = runTest {
            val service = service()
            val upTo = service.askForSnapshot()

            val wrongSeq = assertFailsWith<DomainException>("wrong seq") {
                service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo - 1, byteArrayOf(1)))
            }
            val noRoom = assertFailsWith<DomainException>("no room") {
                service.storeSnapshot(StoreSnapshotCommand(alice, Uuid.random(), 1, byteArrayOf(1)))
            }

            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, wrongSeq.errorCode, "wrong seq")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, noRoom.errorCode, "no room")
            assertTrue(snapshots.snapshots.isEmpty(), "nothing stored")
        }

        @Test
        fun `when the snapshot is above the limit or empty then 413 or 400 and the request stays open`() = runTest {
            val service = service(limits.copy(maxSnapshotBytes = 2))
            val upTo = service.askForSnapshot()

            val tooLarge = assertFailsWith<DomainException>("too large") {
                service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1, 2, 3)))
            }
            val empty = assertFailsWith<DomainException>("empty") {
                service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, ByteArray(0)))
            }
            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1)))

            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, tooLarge.errorCode, "limit")
            assertEquals(ErrorCode.VALIDATION_FAILED, empty.errorCode, "empty")
            assertEquals(1, snapshots.snapshots.size, "the valid upload still worked")
        }

        @Test
        fun `when checking an upload then it needs an open request for exactly this seq, and the request is not consumed`() = runTest {
            val service = service()
            val upTo = service.askForSnapshot()

            val wrongSeq = assertFailsWith<DomainException>("wrong seq") { service.checkSnapshotUpload(alice, board, upTo - 1) }
            val wrongUser = assertFailsWith<DomainException>("wrong user") { service.checkSnapshotUpload(Uuid.random(), board, upTo) }
            service.checkSnapshotUpload(alice, board, upTo)
            service.checkSnapshotUpload(alice, board, upTo)
            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1)))
            val consumed = assertFailsWith<DomainException>("used") { service.checkSnapshotUpload(alice, board, upTo) }

            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, wrongSeq.errorCode, "wrong seq")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, wrongUser.errorCode, "wrong user")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, consumed.errorCode, "the store consumed the request")
        }

        @Test
        fun `when a user starts more uploads than allowed per minute then TOO_MANY_REQUESTS with Retry-After`() = runTest {
            val service = service(limits.copy(snapshotUploadsPerMinute = 2))
            val upTo = service.askForSnapshot()

            repeat(2) { service.checkSnapshotUpload(alice, board, upTo) }
            val limited = assertFailsWith<RateLimitedException>("third") { service.checkSnapshotUpload(alice, board, upTo) }

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, limited.errorCode, "429")
            assertEquals(60L, limited.retryAfterSeconds, "refilled after the minute")
        }

        @Test
        fun `when the kept snapshots would exceed their byte budget then 413 and the request stays open`() = runTest {
            val service = service(limits.copy(snapshotBudgetBytes = 6, snapshotsKept = 2))
            snapshots.insert(StoredSnapshot(board, 0, byteArrayOf(1, 2, 3, 4), alice, FIXED_NOW - 1.hours))
            val upTo = service.askForSnapshot()

            val tooLarge = assertFailsWith<DomainException>("4 + 3 kept: 7 > 6") {
                service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1, 2, 3)))
            }
            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1)))

            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, tooLarge.errorCode, "snapshot budget")
            assertEquals(2, snapshots.snapshots.size, "the small upload fits the budget: 4 + 1 <= 6")
        }

        @Test
        fun `when the kept snapshots exceed the byte budget then the older ones are deleted although they are young`() = runTest {
            val service = service(limits.copy(snapshotsKept = 1, snapshotsKeptDays = 10, snapshotBudgetBytes = 5))
            snapshots.insert(StoredSnapshot(board, 0, byteArrayOf(1, 2, 3), alice, FIXED_NOW - 1.hours))
            val upTo = service.askForSnapshot()

            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1, 2, 3)))

            assertEquals(listOf(upTo), snapshots.snapshots.map { it.second.upToSeq }, "3 + 3 > 5: only the new one stays")
        }

        @Test
        fun `when a second snapshot is stored with one kept then the older snapshot goes and the log keeps what follows`() = runTest {
            val service = service()
            snapshots.insert(StoredSnapshot(board, 1, byteArrayOf(9), alice, FIXED_NOW - 3.days))
            log.entries += LoggedUpdate(board, 1, byteArrayOf(1), alice, FIXED_NOW)
            val upTo = service.askForSnapshot() // seq 2..4 after the existing entry 1... head is 4

            service.storeSnapshot(StoreSnapshotCommand(alice, board, upTo, byteArrayOf(1)))

            assertEquals(listOf(upTo), snapshots.snapshots.map { it.second.upToSeq }, "only the newest is kept")
        }
    }

    @Test
    fun `when refreshing the storage metrics then snapshots and log are reported in bytes`() = runTest {
        val service = service()
        snapshots.insert(StoredSnapshot(board, 1, ByteArray(10), alice, FIXED_NOW))
        log.entries += LoggedUpdate(board, 1, ByteArray(4), alice, FIXED_NOW)

        service.refreshStorageMetrics()

        assertEquals(mapOf("snapshot" to 10L, "log" to 4L), metrics.storage, "bytes by kind")
    }

    @Test
    fun `when a board is deleted then its sessions are closed with 4404 and log and snapshots are gone`() = runTest {
        val service = service()
        access.roles[board to alice] = CollabRole.EDITOR
        val connection = service.open(assertIs<Admission.Admitted>(service.admit(ticketFor(service), board), "admitted"))
        connection.onBinary(byteArrayOf(0x01, 1))
        snapshots.insert(StoredSnapshot(board, 1, byteArrayOf(1), alice, FIXED_NOW))

        service.deleteBoardData(board)

        assertEquals(4404, connection.closeOrder?.code, "close code")
        assertTrue(log.entries.isEmpty() && snapshots.snapshots.isEmpty(), "data deleted")
    }

    @Nested
    inner class Versions {

        private fun TestScope.storedVersion(service: CollabService, upToSeq: Long, data: ByteArray): Uuid {
            kotlinx.coroutines.runBlocking { snapshots.insert(StoredSnapshot(board, upToSeq, data, alice, clock.now())) }
            return kotlinx.coroutines.runBlocking { service.listVersions(board) }.first { it.upToSeq == upToSeq }.id
        }

        @Test
        fun `when listing versions then the snapshots come newest first without bytes`() = runTest {
            val service = service()
            storedVersion(service, 3, byteArrayOf(1))
            storedVersion(service, 9, byteArrayOf(1, 2))

            val versions = service.listVersions(board)

            assertEquals(listOf(9L, 3L), versions.map { it.upToSeq }, "newest first")
            assertEquals(listOf(2L, 1L), versions.map { it.size }, "sizes")
        }

        @Test
        fun `when restoring then the chosen data becomes a new base above everything and the log is dropped`() = runTest {
            val service = service()
            val old = storedVersion(service, 3, byteArrayOf(7, 7))
            storedVersion(service, 9, byteArrayOf(8))
            log.append(LoggedUpdate(board, 10, byteArrayOf(1), alice, clock.now()))
            log.append(LoggedUpdate(board, 11, byteArrayOf(2), alice, clock.now()))

            service.restoreVersion(RestoreVersionCommand(alice, board, old))

            val base = checkNotNull(snapshots.findLatest(board)) { "a new base" }
            assertEquals(12L, base.upToSeq, "a new epoch above the highest log entry")
            assertContentEquals(byteArrayOf(7, 7), base.data, "the chosen bytes")
            assertEquals(null, log.lastSeq(board), "the log is gone")
            assertEquals(listOf(12L, 9L, 3L), service.listVersions(board).map { it.upToSeq }, "the others stay listed")
        }

        @Test
        fun `when restoring then the version restored is audited`() = runTest {
            val service = service()
            val old = storedVersion(service, 3, byteArrayOf(7))

            service.restoreVersion(RestoreVersionCommand(alice, board, old))

            val event = audit.events.single()
            assertEquals("collab.snapshot.restored", event.eventType, "event type")
            assertEquals(VersionRestored(old.toString(), restoredUpToSeq = 3, newBaseSeq = 4), event.details, "details")
        }

        @Test
        fun `when the version is unknown or belongs to another board then COLLAB_VERSION_NOT_FOUND`() = runTest {
            val service = service()
            val elsewhere = Uuid.random()
            snapshots.insert(StoredSnapshot(elsewhere, 3, byteArrayOf(1), alice, clock.now()))
            val foreign = snapshots.listMeta(elsewhere).single().id

            val unknown = assertFailsWith<DomainException>("unknown id") { service.restoreVersion(RestoreVersionCommand(alice, board,
                Uuid.random())) }
            val other = assertFailsWith<DomainException>("another board's version") {
                service.restoreVersion(RestoreVersionCommand(alice, board, foreign))
            }

            assertEquals(listOf(ErrorCode.COLLAB_VERSION_NOT_FOUND, ErrorCode.COLLAB_VERSION_NOT_FOUND), listOf(unknown.errorCode,
                other.errorCode), "404 both")
            assertTrue(audit.events.isEmpty(), "nothing audited")
        }
    }

    @Nested
    inner class Replacing {

        @Test
        fun `when a document is being replaced then its sessions are closed with 4410 and new joins wait until it is done`() = runTest {
            val service = service()
            access.roles[board to alice] = CollabRole.EDITOR
            val admitted = assertIs<Admission.Admitted>(service.admit(ticketFor(service), board), "admitted")
            val connection = service.open(admitted)

            service.beginReplace(board)

            assertEquals(4410, connection.closeOrder?.code, "document replaced")
            val busy = service.admit(ticketFor(service), board)
            assertEquals(Admission.Rejected(RejectionReason.BOARD_BUSY), busy, "no join while the log is rewritten")
            val raced = service.open(admitted)
            assertEquals(4410, raced.closeOrder?.code, "an admission from before the restore is closed too")

            service.endReplace(board)

            assertIs<Admission.Admitted>(service.admit(ticketFor(service), board), "joins are accepted again")
        }
    }
}
