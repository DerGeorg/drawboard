package at.dergeorg.drawboard.api.domain.library

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.shared.testing.FixedCurrentGuestProvider
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.PageInfo
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.UpdateBoardCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.shared.testing.FixedCurrentUserProvider
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.ALICE_ID
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aSyncFromLoginCommand
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import io.mockk.coEvery
import at.dergeorg.drawboard.api.common.BoardDataEraser
import at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole as LibraryBoardRole

class LibraryApiServiceTest {

    private val currentUsers = FixedCurrentUserProvider()
    private val profiles = mockk<UserProfilesUseCase>()
    private val signedInUsers = SignedInUsers(currentUsers, profiles)
    private val library = mockk<BoardsUseCase>()
    private val trash = mockk<TrashUseCase>()
    private val collab = mockk<CollabUseCase>(relaxUnitFun = true)
    private val files = mockk<FilesUseCase>(relaxed = true)
    private val alice = Caller.User(ALICE_ID, ALICE.groups)
    private val service = LibraryApiService(signedInUsers, Callers(signedInUsers, FixedCurrentGuestProvider(), mockk()), library, trash,
        collab, BoardDataEraser(collab, files, mockk(relaxed = true), mockk(relaxed = true)))

    private val board = aBoard(ownerId = ALICE_ID)

    @Nested
    inner class ResolvingTheCaller {

        @Test
        fun `when a known user calls then the library gets the user's own id and nobody is created`() = runTest {
            coEvery { profiles.findByLogin(ALICE.issuer, ALICE.subject) } returns aUserProfile(ALICE)
            coEvery { library.getBoard(alice, BOARD) } returns BoardView(board, LibraryBoardRole.OWNER)

            service.getBoard(BOARD)

            coVerify(exactly = 0) { profiles.syncFromLogin(any()) }
        }

        @Test
        fun `when an unknown user calls a board route first then the profile is created from the token`() = runTest {
            coEvery { profiles.findByLogin(ALICE.issuer, ALICE.subject) } returns null
            coEvery { profiles.syncFromLogin(aSyncFromLoginCommand(ALICE)) } returns aUserProfile(ALICE)
            coEvery { library.getBoard(alice, BOARD) } returns BoardView(board, LibraryBoardRole.OWNER)

            service.getBoard(BOARD)

            coVerify(exactly = 1) { profiles.syncFromLogin(aSyncFromLoginCommand(ALICE)) }
        }

        @Test
        fun `when nobody is signed in then UNAUTHORIZED and the library is not called`() = runTest {
            currentUsers.user = null

            val failure = assertFailsWith<DomainException>("anonymous") { service.getBoard(BOARD) }

            assertEquals(ErrorCode.UNAUTHORIZED, failure.errorCode, "error code")
            coVerify(exactly = 0) { library.getBoard(any(), any()) }
        }
    }

    @Nested
    inner class Operations {

        init {
            coEvery { profiles.findByLogin(ALICE.issuer, ALICE.subject) } returns aUserProfile(ALICE)
        }

        @Test
        fun `when listing then the page is mapped to contract types with its paging info and roles`() = runTest {
            val query = PageQuery(number = 1, size = 5)
            val result = Page(listOf(BoardView(board, LibraryBoardRole.OWNER)), query, totalElements = 6)
            coEvery { library.listBoards(alice, null, query) } returns result

            val page = service.listBoards(folderId = null, page = 1, size = 5)

            assertEquals(listOf(BOARD), page.items.map { it.id }, "boards")
            assertEquals(listOf(BoardRole.OWNER), page.items.map { it.role }, "roles")
            assertEquals(PageInfo(number = 1, size = 5, totalElements = 6, totalPages = 2), page.page, "paging info")
        }

        @Test
        fun `when listing templates then the page is mapped with the template flag and the paging info`() = runTest {
            val query = PageQuery(number = 0, size = 10)
            val result = Page(listOf(BoardView(board.copy(template = true), LibraryBoardRole.VIEWER)), query, totalElements = 1)
            coEvery { library.listTemplates(alice, query) } returns result

            val page = service.listTemplates(page = 0, size = 10)

            assertEquals(listOf(true), page.items.map { it.template }, "template flag")
            assertEquals(listOf(BoardRole.VIEWER), page.items.map { it.role }, "roles")
            assertEquals(PageInfo(number = 0, size = 10, totalElements = 1, totalPages = 1), page.page, "paging info")
        }

        @Test
        fun `when creating a template then the flag goes to the library`() = runTest {
            val command = CreateBoardCommand(ownerId = ALICE_ID, title = "Roadmap", template = true)
            coEvery { library.createBoard(command) } returns BoardView(board.copy(template = true), LibraryBoardRole.OWNER)

            val created = service.createBoard(NewBoard("Roadmap", template = true))

            assertEquals(true, created.template, "contract board is a template")
        }

        @Test
        fun `when updating with a template flag then it goes to the library, absent stays null`() = runTest {
            val withFlag = UpdateBoardCommand(caller = alice, boardId = BOARD, title = "Retro", version = 4, template = true)
            coEvery { library.updateBoard(withFlag) } returns BoardView(board.copy(template = true), LibraryBoardRole.OWNER)
            coEvery { library.updateBoard(withFlag.copy(template = null)) } returns BoardView(board, LibraryBoardRole.OWNER)

            val marked = service.updateBoard(BOARD, BoardUpdate(title = "Retro", version = 4, template = true))
            val untouched = service.updateBoard(BOARD, BoardUpdate(title = "Retro", version = 4))

            assertEquals(true to false, marked.template to untouched.template, "flag passed on, absent = unchanged")
        }

        @Test
        fun `when creating then the caller becomes the owner and the contract board carries every field`() = runTest {
            val command = CreateBoardCommand(ownerId = ALICE_ID, title = "Roadmap")
            coEvery { library.createBoard(command) } returns BoardView(board, LibraryBoardRole.OWNER)

            val created = service.createBoard(NewBoard("Roadmap"))

            assertEquals(
                listOf(board.id, board.title, ALICE_ID, BoardRole.OWNER, board.createdAt, board.updatedAt, board.version),
                listOf(created.id, created.title, created.ownerId, created.role, created.createdAt, created.updatedAt, created.version),
                "contract board",
            )
        }

        @Test
        fun `when renaming then user, board, title and version go to the library`() = runTest {
            val command = UpdateBoardCommand(caller = alice, boardId = BOARD, title = "Retro", version = 4)
            coEvery { library.updateBoard(command) } returns BoardView(board.copy(title = "Retro", version = 5),
                LibraryBoardRole.EDITOR)

            val renamed = service.updateBoard(BOARD, BoardUpdate(title = "Retro", version = 4))

            assertEquals("Retro" to 5L, renamed.title to renamed.version, "renamed board")
            assertEquals(BoardRole.EDITOR, renamed.role, "role is passed on")
        }

        @Test
        fun `when deleting then user and board go to the library`() = runTest {
            coEvery { library.deleteBoard(alice, BOARD) } returns Unit

            service.deleteBoard(BOARD)

            coVerify(exactly = 1) { library.deleteBoard(alice, BOARD) }
            coVerify(exactly = 1) { collab.closeSessions(BOARD) }
            coVerify(exactly = 0) { collab.deleteBoardData(any()) }
        }
    }
}
