package at.dergeorg.drawboard.library.domain.access

import at.dergeorg.drawboard.library.domain.InMemoryFolderRepository
import at.dergeorg.drawboard.library.domain.InMemoryGrantRepository
import at.dergeorg.drawboard.library.domain.InMemoryShareLinkRepository
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.uuid.Uuid

class AccessResolverTest {

    private val top = Folder(Uuid.generateV7(), "top", OWNER, null, FIXED_NOW, FIXED_NOW)
    private val middle = Folder(Uuid.generateV7(), "middle", OWNER, top.id, FIXED_NOW, FIXED_NOW)
    private val board = aBoard(id = Uuid.generateV7(), folderId = middle.id)

    private fun grant(kind: ResourceKind, resource: Uuid, principalKind: PrincipalKind, principal: String, role: BoardRole) = Grant(
        Uuid.generateV7(), kind, resource, principalKind, principal, role, linkId = null, createdAt = FIXED_NOW, updatedAt = FIXED_NOW,
    )

    private fun resolver(vararg grants: Grant) =
        AccessResolver(InMemoryFolderRepository(top, middle), InMemoryGrantRepository(*grants), InMemoryShareLinkRepository(),
            MutableClock())

    @Nested
    inner class Users {

        @Test
        fun `when asking for the owner then OWNER, also on a board in nested folders`() = runTest {
            assertEquals(BoardRole.OWNER, resolver().boardRole(board, asUser(OWNER)), "owner")
        }

        @Test
        fun `when nothing is granted then a stranger has no role`() = runTest {
            assertNull(resolver().boardRole(board, asUser(STRANGER)), "no grant, no role")
        }

        @Test
        fun `when a grant sits on a folder above then the board inherits it`() = runTest {
            val granted = grant(ResourceKind.FOLDER, top.id, PrincipalKind.USER, STRANGER.toString(), BoardRole.COMMENTER)

            assertEquals(BoardRole.COMMENTER, resolver(granted).boardRole(board, asUser(STRANGER)), "inherited from two levels up")
            assertEquals(BoardRole.COMMENTER, resolver(granted).folderRole(middle, asUser(STRANGER)), "and the subfolder too")
        }

        @Test
        fun `when grants exist on the folder and on the board then the strongest role wins`() = runTest {
            val onFolder = grant(ResourceKind.FOLDER, top.id, PrincipalKind.USER, STRANGER.toString(), BoardRole.EDITOR)
            val onBoard = grant(ResourceKind.BOARD, board.id, PrincipalKind.USER, STRANGER.toString(), BoardRole.VIEWER)

            val role = resolver(onFolder, onBoard).boardRole(board, asUser(STRANGER))
            assertEquals(BoardRole.EDITOR, role, "EDITOR beats VIEWER, not the nearest")
        }

        @Test
        fun `when a group is granted then it counts only for a token that carries the group now`() = runTest {
            val group = grant(ResourceKind.BOARD, board.id, PrincipalKind.GROUP, "designers", BoardRole.EDITOR)

            assertEquals(BoardRole.EDITOR, resolver(group).boardRole(board, asUser(STRANGER, "designers")), "token has the group")
            assertNull(resolver(group).boardRole(board, asUser(STRANGER)), "token without the group: no role, whatever was stored")
        }

        @Test
        fun `when a user grant names another user then it does not apply`() = runTest {
            val other = grant(ResourceKind.BOARD, board.id, PrincipalKind.USER, Uuid.generateV7().toString(), BoardRole.EDITOR)

            assertNull(resolver(other).boardRole(board, asUser(STRANGER)), "someone else's grant")
        }

        @Test
        fun `when the board is in the trash then nobody has a role`() = runTest {
            val trashed = board.copy(deletedAt = FIXED_NOW)

            assertNull(resolver().boardRole(trashed, asUser(OWNER)), "not even the owner")
        }
    }

    @Nested
    inner class Guests {

        @Test
        fun `when a guest holds a board share then that board has the share's role and no other board`() = runTest {
            val guest = Caller.Guest(Uuid.generateV7(), ResourceKind.BOARD, board.id, BoardRole.VIEWER)

            assertEquals(BoardRole.VIEWER, resolver().boardRole(board, guest), "the shared board")
            assertNull(resolver().boardRole(aBoard(id = Uuid.generateV7(), folderId = middle.id), guest), "a sibling board")
        }

        @Test
        fun `when a guest holds a folder share then boards and folders below have the role but not the parent`() = runTest {
            val guest = Caller.Guest(Uuid.generateV7(), ResourceKind.FOLDER, middle.id, BoardRole.EDITOR)

            assertEquals(BoardRole.EDITOR, resolver().boardRole(board, guest), "board below the folder")
            assertEquals(BoardRole.EDITOR, resolver().folderRole(middle, guest), "the folder itself")
            assertNull(resolver().folderRole(top, guest), "the folder above")
        }

        @Test
        fun `when a share carries OWNER then it grants nothing`() = runTest {
            val guest = Caller.Guest(Uuid.generateV7(), ResourceKind.BOARD, board.id, BoardRole.OWNER)

            assertNull(resolver().boardRole(board, guest), "owner is never shared")
        }
    }
}
