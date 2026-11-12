package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.domain.boards.model.BoardCreated
import at.dergeorg.drawboard.library.domain.boards.model.BoardDeleted
import at.dergeorg.drawboard.library.domain.boards.model.BoardRenamed
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.aCreateBoardCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.aRenameBoardCommand
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import at.dergeorg.drawboard.shared.testing.version
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

class LibraryServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()

    private val folders = InMemoryFolderRepository()

    private fun serviceWith(repository: InMemoryBoardRepository) =
        LibraryService(repository, folders, AccessResolver(folders, InMemoryGrantRepository(), InMemoryShareLinkRepository(), clock),
            audit, clock)

    @Nested
    inner class ListBoards {

        @Test
        fun `when listing given boards of two owners then only the own ones come, most recently changed first`() = runTest {
            val old = aBoard(id = Uuid.random(), title = "old", updatedAt = FIXED_NOW)
            val recent = aBoard(id = Uuid.random(), title = "recent", updatedAt = FIXED_NOW + 1.hours)
            val foreign = aBoard(id = Uuid.random(), title = "foreign", ownerId = STRANGER, updatedAt = FIXED_NOW + 2.hours)

            val page = serviceWith(InMemoryBoardRepository(old, foreign, recent)).listBoards(asUser(OWNER), null, PageQuery(0, 20))

            assertEquals(listOf("recent", "old"), page.items.map { it.board.title }, "own boards, newest change first")
            assertEquals(setOf(BoardRole.OWNER), page.items.map { it.role }.toSet(), "role on own boards")
            assertEquals(2, page.totalElements, "total of the own boards")
        }

        @Test
        fun `when listing given a user without boards then the page is empty`() = runTest {
            val page = serviceWith(InMemoryBoardRepository(aBoard())).listBoards(asUser(STRANGER), null, PageQuery(0, 20))

            assertTrue(page.items.isEmpty(), "nothing owned")
            assertEquals(0, page.totalElements, "total")
        }
    }

    @Nested
    inner class CreateBoard {

        @Test
        fun `when creating then the owner gets a trimmed board with a v7 id and the creation is audited`() = runTest {
            val repository = InMemoryBoardRepository()

            val view = serviceWith(repository).createBoard(aCreateBoardCommand(title = "  Roadmap  "))

            assertEquals("Roadmap", view.board.title, "title is trimmed")
            assertEquals(OWNER, view.board.ownerId, "creator owns it")
            assertEquals(BoardRole.OWNER, view.role, "creator is the owner")
            assertEquals(7, view.board.id.version(), "the application assigns a UUIDv7")
            assertEquals(FIXED_NOW, view.board.createdAt, "creation time")
            assertEquals(view.board.createdAt, view.board.updatedAt, "not changed yet")
            assertEquals(listOf(view.board), repository.all, "stored boards")
            val event = audit.events.single()
            assertEquals("library.board.created", event.eventType, "event type")
            assertEquals(AuditAction.CREATED, event.action, "action")
            assertEquals(BoardCreated(submittedTitle = "  Roadmap  "), event.details, "details keep the submitted title")
        }

        @Test
        fun `when creating given a blank title then VALIDATION_FAILED and nothing is stored or audited`() = runTest {
            val repository = InMemoryBoardRepository()

            val failure = assertFailsWith<ValidationFailedException>("a blank title is rejected") {
                serviceWith(repository).createBoard(CreateBoardCommand(OWNER, "   "))
            }

            assertEquals("title", failure.invalidFields.single().field, "invalid field")
            assertTrue(repository.all.isEmpty() && audit.events.isEmpty(), "no board, no event")
        }

        @Test
        fun `when creating given a title over 200 characters then VALIDATION_FAILED`() = runTest {
            val failure = assertFailsWith<ValidationFailedException>("too long") {
                serviceWith(InMemoryBoardRepository()).createBoard(aCreateBoardCommand(title = "x".repeat(201)))
            }

            assertEquals("Size", failure.invalidFields.single().constraint, "violated constraint")
        }
    }

    @Nested
    inner class GetBoard {

        @Test
        fun `when getting given the owner then the board comes with the role OWNER`() = runTest {
            val view = serviceWith(InMemoryBoardRepository(aBoard())).getBoard(asUser(OWNER), BOARD)

            assertEquals(aBoard(), view.board, "the board")
            assertEquals(BoardRole.OWNER, view.role, "role")
        }

        @Test
        fun `when getting given another user then LIBRARY_BOARD_NOT_FOUND so the existence is not revealed`() = runTest {
            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(InMemoryBoardRepository(aBoard())).getBoard(asUser(STRANGER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
        }

        @Test
        fun `when getting given an unknown id then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("unknown id") {
                serviceWith(InMemoryBoardRepository()).getBoard(asUser(OWNER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "same answer as for a foreign board")
            assertEquals(mapOf("boardId" to BOARD.toString()), failure.params, "params")
        }
    }

    @Nested
    inner class RenameBoard {

        @Test
        fun `when renaming given the current version then title, version and update time change and it is audited`() = runTest {
            val stored = aBoard()
            val repository = InMemoryBoardRepository(stored)
            clock.advanceBy(10.minutes)

            val view = serviceWith(repository).renameBoard(aRenameBoardCommand(title = " Retro "))

            assertEquals("Retro", view.board.title, "new title")
            assertEquals(1, view.board.version, "version raised")
            assertEquals(FIXED_NOW + 10.minutes, view.board.updatedAt, "update time")
            assertEquals(stored.createdAt, view.board.createdAt, "creation time stays")
            assertEquals(listOf(view.board), repository.all, "stored boards")
            val event = audit.events.single()
            assertEquals("library.board.updated", event.eventType, "event type")
            assertEquals(stored, event.before, "snapshot before")
            assertEquals(view.board, event.after, "snapshot after")
            assertEquals(BoardRenamed(submittedTitle = " Retro ", basedOnVersion = 0), event.details, "details")
        }

        @Test
        fun `when renaming given a stale version then CONFLICT and nothing changes`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(version = 3))

            val failure = assertFailsWith<DomainException>("stale version") {
                serviceWith(repository).renameBoard(aRenameBoardCommand(version = 2))
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
            assertEquals(aBoard(version = 3), repository.all.single(), "board untouched")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given a concurrent change between read and write then CONFLICT`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())
            repository.failNextUpdate = true

            val failure = assertFailsWith<DomainException>("lost the race") {
                serviceWith(repository).renameBoard(aRenameBoardCommand())
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
            assertTrue(audit.events.isEmpty(), "no event for a change that did not happen")
        }

        @Test
        fun `when renaming given the same title then nothing is written or audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(title = "Retro"))

            val view = serviceWith(repository).renameBoard(aRenameBoardCommand(title = " Retro"))

            assertEquals(0, view.board.version, "version unchanged")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given another user then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(InMemoryBoardRepository(aBoard())).renameBoard(aRenameBoardCommand(caller = asUser(STRANGER)))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when renaming given a blank title then VALIDATION_FAILED`() = runTest {
            assertFailsWith<ValidationFailedException>("blank title") {
                serviceWith(InMemoryBoardRepository(aBoard())).renameBoard(aRenameBoardCommand(title = " "))
            }
        }
    }

    @Nested
    inner class DeleteBoard {

        @Test
        fun `when deleting given the owner then the board is in the trash and the deletion is audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())
            clock.advanceBy(2.hours)

            serviceWith(repository).deleteBoard(asUser(OWNER), BOARD)

            assertEquals(clock.now(), repository.all.single().deletedAt, "board is marked as deleted, not removed")
            val event = audit.events.single()
            assertEquals("library.board.deleted", event.eventType, "event type")
            assertEquals(BoardDeleted(age = 2.hours), event.details, "details: how old the board was")
            assertEquals(aBoard(), event.before, "snapshot before")
        }

        @Test
        fun `when deleting given another user then LIBRARY_BOARD_NOT_FOUND and the board stays`() = runTest {
            val repository = InMemoryBoardRepository(aBoard())

            val failure = assertFailsWith<DomainException>("a foreign board looks like it does not exist") {
                serviceWith(repository).deleteBoard(asUser(STRANGER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
            assertEquals(1, repository.all.size, "board stays")
            assertTrue(audit.events.isEmpty(), "no event")
        }

        @Test
        fun `when deleting given an unknown id then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("unknown id") {
                serviceWith(InMemoryBoardRepository()).deleteBoard(asUser(OWNER), BOARD)
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
        }
    }

    @Nested
    inner class RoleOf {

        @Test
        fun `when asking for the role then the owner is OWNER and a stranger or an unknown board has none`() = runTest {
            val service = serviceWith(InMemoryBoardRepository(aBoard()))

            assertEquals(BoardRole.OWNER, service.roleOf(asUser(OWNER), BOARD), "owner")
            assertNull(service.roleOf(asUser(STRANGER), BOARD), "stranger")
            assertNull(service.roleOf(asUser(OWNER), Uuid.random()), "unknown board - null, not an exception")
        }
    }

    @Nested
    inner class RecordContentChange {

        @Test
        fun `when the drawing changed then updatedAt moves forward, the version stays and nothing is audited`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(updatedAt = FIXED_NOW, version = 3))

            serviceWith(repository).recordContentChange(BOARD, FIXED_NOW + 1.hours)

            assertEquals(FIXED_NOW + 1.hours, repository.all.single().updatedAt, "updated at")
            assertEquals(3, repository.all.single().version, "a rename in progress must not conflict with the drawing")
            assertTrue(audit.events.isEmpty(), "content changes are not audited")
        }

        @Test
        fun `when an older change is reported late then updatedAt is not lowered, and an unknown board is ignored`() = runTest {
            val repository = InMemoryBoardRepository(aBoard(updatedAt = FIXED_NOW + 2.hours))
            val service = serviceWith(repository)

            service.recordContentChange(BOARD, FIXED_NOW + 1.hours)
            service.recordContentChange(Uuid.random(), FIXED_NOW)

            assertEquals(FIXED_NOW + 2.hours, repository.all.single().updatedAt, "never lowered")
        }
    }
}
