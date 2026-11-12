package at.dergeorg.drawboard.library.domain.sharing

import at.dergeorg.drawboard.library.domain.InMemoryBoardRepository
import at.dergeorg.drawboard.library.domain.InMemoryFolderRepository
import at.dergeorg.drawboard.library.domain.InMemoryGrantRepository
import at.dergeorg.drawboard.library.domain.InMemoryShareLinkRepository
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.sharing.provides.SetMemberCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.impl.MembersService
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class MembersServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()
    private val folder = Folder(Uuid.generateV7(), "shared", OWNER, null, FIXED_NOW, FIXED_NOW)
    private val folders = InMemoryFolderRepository(folder)
    private val boards = InMemoryBoardRepository(aBoard(folderId = folder.id))
    private val grants = InMemoryGrantRepository()
    private val service = MembersService(boards, folders, grants, AccessResolver(folders, grants, InMemoryShareLinkRepository(), clock),
        audit, clock)

    private fun set(who: Uuid, principal: String, role: BoardRole, kind: ResourceKind = ResourceKind.BOARD, id: Uuid = BOARD) =
        SetMemberCommand(asUser(who), kind, id, principal, role)

    @Nested
    inner class SetMember {

        @Test
        fun `when the owner grants a user then the user gets the role and the change is audited`() = runTest {
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.EDITOR))

            val members = service.listMembers(asUser(STRANGER), ResourceKind.BOARD, BOARD).members
            assertEquals(BoardRole.EDITOR, members.single().grant.role, "grant")
            val event = audit.events.single()
            assertEquals("library.board.acl-changed", event.eventType, "event type")
        }

        @Test
        fun `when granting again then the role is replaced, not duplicated`() = runTest {
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.EDITOR))
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.VIEWER))

            assertEquals(listOf(BoardRole.VIEWER), grants.all.map { it.role }, "one grant with the last role")
        }

        @Test
        fun `when granting the owner then VALIDATION_FAILED`() = runTest {
            assertFailsWith<ValidationFailedException>("owner is not a member") {
                service.setUserMember(set(OWNER, OWNER.toString(), BoardRole.VIEWER))
            }
        }

        @Test
        fun `when granting OWNER then VALIDATION_FAILED`() = runTest {
            assertFailsWith<ValidationFailedException>("OWNER is never granted") {
                service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.OWNER))
            }
        }

        @Test
        fun `when an editor tries to grant then LIBRARY_BOARD_ACCESS_DENIED`() = runTest {
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.EDITOR))

            val failure = assertFailsWith<DomainException>("only the owner shares") {
                service.setUserMember(set(STRANGER, Uuid.generateV7().toString(), BoardRole.VIEWER))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, failure.errorCode, "403, not 404: the editor sees the board")
        }

        @Test
        fun `when a stranger tries to grant then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("no role, no knowledge") {
                service.setUserMember(set(STRANGER, Uuid.generateV7().toString(), BoardRole.VIEWER))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "existence is hidden")
        }

        @Test
        fun `when granting a group on a folder then the board below shows the grant as inherited`() = runTest {
            service.setGroupMember(set(OWNER, "designers", BoardRole.COMMENTER, ResourceKind.FOLDER, folder.id))

            val members = service.listMembers(asUser(OWNER), ResourceKind.BOARD, BOARD).members
            assertEquals(listOf(folder.id), members.map { it.inheritedFrom }, "inherited from the folder")
            assertEquals(PrincipalKind.GROUP, members.single().grant.principalKind, "group grant")
        }
    }

    @Nested
    inner class RemoveMember {

        @Test
        fun `when removing a grant then it is gone and audited, removing again changes nothing`() = runTest {
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.VIEWER))

            service.removeUserMember(asUser(OWNER), ResourceKind.BOARD, BOARD, STRANGER)
            service.removeUserMember(asUser(OWNER), ResourceKind.BOARD, BOARD, STRANGER)

            assertTrue(grants.all.isEmpty(), "gone")
            assertEquals(2, audit.events.size, "one set and one remove; the repeated remove is no change")
        }
    }

    @Nested
    inner class SharedWithMe {

        @Test
        fun `when others granted me a board and a folder then both are listed with my role, trash excluded`() = runTest {
            service.setUserMember(set(OWNER, STRANGER.toString(), BoardRole.EDITOR))
            service.setGroupMember(set(OWNER, "designers", BoardRole.VIEWER, ResourceKind.FOLDER, folder.id))

            val shared = service.listSharedWithMe(asUser(STRANGER, "designers"))

            assertEquals(listOf(BoardRole.EDITOR), shared.boards.map { it.role }, "board by user grant")
            assertEquals(listOf(BoardRole.VIEWER), shared.folders.map { it.role }, "folder by group grant")
        }

        @Test
        fun `when I am not in the group any more then the folder is not listed`() = runTest {
            service.setGroupMember(set(OWNER, "designers", BoardRole.VIEWER, ResourceKind.FOLDER, folder.id))

            assertTrue(service.listSharedWithMe(asUser(STRANGER)).folders.isEmpty(), "groups come from the current token")
        }
    }
}
