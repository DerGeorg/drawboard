package at.dergeorg.drawboard.library.domain.folders

import at.dergeorg.drawboard.library.domain.InMemoryBoardRepository
import at.dergeorg.drawboard.library.domain.InMemoryFolderRepository
import at.dergeorg.drawboard.library.domain.InMemoryGrantRepository
import at.dergeorg.drawboard.library.domain.InMemoryShareLinkRepository
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.provides.impl.FoldersService
import at.dergeorg.drawboard.library.domain.folders.provides.CreateFolderCommand
import at.dergeorg.drawboard.library.domain.folders.provides.UpdateFolderCommand
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class FoldersServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()
    private val folders = InMemoryFolderRepository()
    private val boards = InMemoryBoardRepository()
    private val service = FoldersService(folders, boards, AccessResolver(folders, InMemoryGrantRepository(),
        InMemoryShareLinkRepository(), clock), audit, clock)

    private fun aFolder(name: String, parent: Uuid? = null, owner: Uuid = OWNER) =
        Folder(id = Uuid.generateV7(), name = name, ownerId = owner, parentId = parent, createdAt = FIXED_NOW, updatedAt = FIXED_NOW)

    @Nested
    inner class Create {

        @Test
        fun `when creating given a blank name then VALIDATION_FAILED`() = runTest {
            assertFailsWith<at.dergeorg.drawboard.shared.error.ValidationFailedException>("blank name") {
                service.createFolder(CreateFolderCommand(OWNER, "  ", null))
            }
        }

        @Test
        fun `when creating below a folder of someone else then LIBRARY_FOLDER_NOT_FOUND`() = runTest {
            val foreign = folders.insert(aFolder("theirs", owner = STRANGER))

            val failure = assertFailsWith<DomainException>("foreign parent") {
                service.createFolder(CreateFolderCommand(OWNER, "mine", foreign.id))
            }

            assertEquals(ErrorCode.LIBRARY_FOLDER_NOT_FOUND, failure.errorCode, "error code")
        }

        @Test
        fun `when creating given a name with blanks then the folder is trimmed, owned by the creator and audited`() = runTest {
            val view = service.createFolder(CreateFolderCommand(OWNER, " Plans ", null))

            assertEquals("Plans", view.folder.name, "trimmed name")
            assertEquals(OWNER, view.folder.ownerId, "creator owns it")
            assertEquals("library.folder.created", audit.events.single().eventType, "audit event")
        }
    }

    @Nested
    inner class Update {

        @Test
        fun `when moving a folder into its own subfolder then LIBRARY_FOLDER_CYCLE`() = runTest {
            val parent = folders.insert(aFolder("parent"))
            val child = folders.insert(aFolder("child", parent.id))

            val failure = assertFailsWith<DomainException>("cycle") {
                service.updateFolder(UpdateFolderCommand(asUser(OWNER), parent.id, "parent", child.id, parent.version))
            }

            assertEquals(ErrorCode.LIBRARY_FOLDER_CYCLE, failure.errorCode, "error code")
        }

        @Test
        fun `when moving a folder into itself then LIBRARY_FOLDER_CYCLE`() = runTest {
            val folder = folders.insert(aFolder("a"))

            val failure = assertFailsWith<DomainException>("self") {
                service.updateFolder(UpdateFolderCommand(asUser(OWNER), folder.id, "a", folder.id, folder.version))
            }

            assertEquals(ErrorCode.LIBRARY_FOLDER_CYCLE, failure.errorCode, "error code")
        }

        @Test
        fun `when updating given an outdated version then CONFLICT`() = runTest {
            val folder = folders.insert(aFolder("a"))

            val failure = assertFailsWith<DomainException>("stale") {
                service.updateFolder(UpdateFolderCommand(asUser(OWNER), folder.id, "b", null, version = 5))
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
        }

        @Test
        fun `when updating a folder of someone else then LIBRARY_FOLDER_NOT_FOUND`() = runTest {
            val folder = folders.insert(aFolder("a"))

            val failure = assertFailsWith<DomainException>("stranger") {
                service.updateFolder(UpdateFolderCommand(asUser(STRANGER), folder.id, "b", null, folder.version))
            }

            assertEquals(ErrorCode.LIBRARY_FOLDER_NOT_FOUND, failure.errorCode, "existence is not revealed")
        }

        @Test
        fun `when renaming and moving to a valid parent then the folder changes and the version rises`() = runTest {
            val target = folders.insert(aFolder("target"))
            val folder = folders.insert(aFolder("a"))

            val view = service.updateFolder(UpdateFolderCommand(asUser(OWNER), folder.id, "b", target.id, folder.version))

            assertEquals("b", view.folder.name, "name")
            assertEquals(target.id, view.folder.parentId, "parent")
            assertEquals(folder.version + 1, view.folder.version, "version")
        }
    }

    @Nested
    inner class Delete {

        @Test
        fun `when deleting a folder then it and everything below get the same deletedAt and the boards are reported`() = runTest {
            val parent = folders.insert(aFolder("parent"))
            val child = folders.insert(aFolder("child", parent.id))
            val inParent = boards.insert(aBoard(id = Uuid.generateV7(), folderId = parent.id))
            val inChild = boards.insert(aBoard(id = Uuid.generateV7(), folderId = child.id))
            val outside = boards.insert(aBoard(id = Uuid.generateV7()))
            clock.advanceBy(kotlin.time.Duration.parse("1h"))

            val gone = service.deleteFolder(asUser(OWNER), parent.id)

            assertEquals(setOf(inParent.id, inChild.id), gone.toSet(), "boards that went to the trash")
            assertEquals(setOf(clock.now()), folders.all.map { it.deletedAt }.toSet(), "one instant for the whole deletion")
            assertEquals(clock.now(), boards.findById(inChild.id)?.deletedAt, "board below is marked too")
            assertNull(boards.findById(outside.id)?.deletedAt, "a board outside stays")
        }

        @Test
        fun `when listing after a deletion then the deleted folder is gone from the list`() = runTest {
            val folder = folders.insert(aFolder("a"))
            service.deleteFolder(asUser(OWNER), folder.id)

            assertTrue(service.listFolders(asUser(OWNER), null).isEmpty(), "trash is not listed")
        }
    }
}
