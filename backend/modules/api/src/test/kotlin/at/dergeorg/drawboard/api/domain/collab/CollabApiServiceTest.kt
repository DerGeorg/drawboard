package at.dergeorg.drawboard.api.domain.collab

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.shared.testing.FixedCurrentGuestProvider
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.StoreSnapshotCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssuedTicket
import at.dergeorg.drawboard.collab.domain.tickets.provides.TicketsUseCase
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedCurrentUserProvider
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.ALICE_ID
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import at.dergeorg.drawboard.library.domain.access.model.Caller
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.verify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.core.io.buffer.DefaultDataBufferFactory
import org.springframework.http.codec.multipart.Part
import reactor.core.publisher.Flux
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Duration.Companion.minutes

class CollabApiServiceTest {

    private val tokenExpiry = FIXED_NOW + 5.minutes
    private val currentUsers = FixedCurrentUserProvider(ALICE.copy(tokenExpiresAt = tokenExpiry))
    private val profiles = mockk<UserProfilesUseCase>()
    private val signedInUsers = SignedInUsers(currentUsers, profiles)
    private val alice = Caller.User(ALICE_ID, ALICE.groups)
    private val boards = mockk<BoardsUseCase>()
    private val tickets = mockk<TicketsUseCase>()
    private val collab = mockk<CollabUseCase>(relaxUnitFun = true)
    private val service = CollabApiService(
        signedInUsers, Callers(signedInUsers, FixedCurrentGuestProvider(),
            mockk()), boards, tickets, collab, basePath = "/api", maxSnapshotBytes = 4,
    )

    init {
        coEvery { profiles.findByLogin(ALICE.issuer, ALICE.subject) } returns aUserProfile(ALICE)
    }

    private fun part(vararg chunks: ByteArray): Part {
        val factory = DefaultDataBufferFactory.sharedInstance
        return mockk<Part> { coEvery { content() } returns Flux.fromIterable(chunks.map { factory.wrap(it) }) }
    }

    @Nested
    inner class CreateTicket {

        @Test
        fun `when a user with a role asks then the ticket is bound to user, board, name and token expiry`() = runTest {
            coEvery { boards.getBoard(alice, BOARD) } returns BoardView(aBoard(), BoardRole.VIEWER)
            val command = slot<IssueTicketCommand>()
            coEvery { tickets.issue(capture(command)) } returns IssuedTicket("t".repeat(43), FIXED_NOW + 30.minutes)

            val ticket = service.createTicket(BOARD)

            val expected = IssueTicketCommand(ALICE_ID, BOARD, "Alice Admin", tokenExpiry, groups = ALICE.groups)
            assertEquals(expected, command.captured, "ticket binding")
            assertEquals("/api/boards/$BOARD/collab", ticket.url, "path of the WebSocket")
            assertEquals("drawboard.v1", ticket.protocol, "subprotocol")
            assertEquals("t".repeat(43), ticket.ticket, "ticket")
        }

        @Test
        fun `when the user has no role then LIBRARY_BOARD_NOT_FOUND and no ticket is issued`() = runTest {
            coEvery { boards.getBoard(alice, BOARD) } throws DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND)

            val failure = assertFailsWith<DomainException>("no role") { service.createTicket(BOARD) }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
            coVerify(exactly = 0) { tickets.issue(any()) }
        }

        @Test
        fun `when the token has no expiry then UNAUTHORIZED - a ticket must be bound to one`() = runTest {
            currentUsers.user = ALICE.copy(tokenExpiresAt = null)
            coEvery { boards.getBoard(alice, BOARD) } returns BoardView(aBoard(), BoardRole.OWNER)

            val failure = assertFailsWith<DomainException>("no exp") { service.createTicket(BOARD) }

            assertEquals(ErrorCode.UNAUTHORIZED, failure.errorCode, "error code")
        }
    }

    @Nested
    inner class UploadSnapshot {

        @Test
        fun `when an editor uploads then collab gets the user the board the seq and the bytes`() = runTest {
            coEvery { boards.roleOf(alice, BOARD) } returns BoardRole.EDITOR
            val command = slot<StoreSnapshotCommand>()
            coEvery { collab.storeSnapshot(capture(command)) } returns Unit

            service.uploadSnapshot(BOARD, 7, part(byteArrayOf(1, 2), byteArrayOf(3)))

            assertEquals(listOf(ALICE_ID, BOARD, 7L), command.captured.let { listOf(it.userId, it.boardId, it.upToSeq) }, "command")
            assertContentEquals(byteArrayOf(1, 2, 3), command.captured.data, "the chunks of the part, joined")
        }

        @Test
        fun `when a viewer or commenter uploads then LIBRARY_BOARD_ACCESS_DENIED, and without a role LIBRARY_BOARD_NOT_FOUND`() =
            runTest {
            coEvery { boards.roleOf(alice, BOARD) } returnsMany listOf(BoardRole.VIEWER, BoardRole.COMMENTER, null)

            val codes = List(3) {
                assertFailsWith<DomainException>("upload $it") { service.uploadSnapshot(BOARD, 1, part(byteArrayOf(1))) }.errorCode
            }

            assertEquals(
                listOf(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, ErrorCode.LIBRARY_BOARD_NOT_FOUND),
                codes,
                "viewer, commenter, stranger",
            )
            coVerify(exactly = 0) { collab.storeSnapshot(any()) }
        }

        @Test
        fun `when the upload was not requested or the user is rate limited then the body is not read at all`() = runTest {
            coEvery { boards.roleOf(alice, BOARD) } returns BoardRole.OWNER
            coEvery { collab.checkSnapshotUpload(ALICE_ID, BOARD, 1) } throws
                DomainException(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED) andThenThrows RateLimitedException(retryAfterSeconds = 7)
            val body = part(byteArrayOf(1, 2, 3), byteArrayOf(4, 5)) // larger than the limit of 4: would be a 413 if read

            val notRequested = assertFailsWith<DomainException>("not requested") { service.uploadSnapshot(BOARD, 1, body) }
            val limited = assertFailsWith<RateLimitedException>("rate limited") { service.uploadSnapshot(BOARD, 1, body) }

            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, notRequested.errorCode, "409, not 413")
            assertEquals(7L, limited.retryAfterSeconds, "Retry-After")
            verify(exactly = 0) { body.content() }
            coVerify(exactly = 0) { collab.storeSnapshot(any()) }
        }

        @Test
        fun `when the upload is allowed then the check comes before the body is read and the store after`() = runTest {
            coEvery { boards.roleOf(alice, BOARD) } returns BoardRole.EDITOR
            val body = part(byteArrayOf(1))

            service.uploadSnapshot(BOARD, 3, body)

            coVerifyOrder {
                collab.checkSnapshotUpload(ALICE_ID, BOARD, 3)
                body.content()
                collab.storeSnapshot(any())
            }
        }

        @Test
        fun `when the part is larger than the limit then PAYLOAD_TOO_LARGE with the limit and nothing is stored`() = runTest {
            coEvery { boards.roleOf(alice, BOARD) } returns BoardRole.OWNER

            val failure = assertFailsWith<DomainException>("5 bytes against a limit of 4") {
                service.uploadSnapshot(BOARD, 1, part(byteArrayOf(1, 2, 3), byteArrayOf(4, 5)))
            }

            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, failure.errorCode, "error code")
            assertEquals(mapOf("limit" to "4"), failure.params, "limit in bytes")
            coVerify(exactly = 0) { collab.storeSnapshot(any()) }
        }
    }
}
