package at.dergeorg.drawboard.library.domain.trash

import at.dergeorg.drawboard.library.domain.InMemoryBoardRepository
import at.dergeorg.drawboard.library.domain.InMemoryFolderRepository
import at.dergeorg.drawboard.library.domain.InMemoryGrantRepository
import at.dergeorg.drawboard.library.domain.InMemoryShareLinkRepository
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.trash.provides.impl.TrashService
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
import kotlin.time.Duration.Companion.days
import kotlin.uuid.Uuid

class TrashServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()
    private val folders = InMemoryFolderRepository()
    private val boards = InMemoryBoardRepository()
    private val service = TrashService(boards, folders, ResourceEraser(boards, folders, InMemoryGrantRepository(),
        InMemoryShareLinkRepository()), audit, clock)

    private fun aFolder(parent: Uuid? = null, deletedAt: kotlin.time.Instant? = null) = Folder(
        id = Uuid.generateV7(), name = "f", ownerId = OWNER, parentId = parent,
        createdAt = FIXED_NOW, updatedAt = FIXED_NOW, deletedAt = deletedAt,
    )

    @Nested
    inner class ListTrash {

        @Test
        fun `when a folder was deleted with its content then only the folder is listed`() = runTest {
            val folder = folders.insert(aFolder(deletedAt = FIXED_NOW))
            boards.insert(aBoard(id = Uuid.generateV7(), folderId = folder.id, deletedAt = FIXED_NOW))
            val single = boards.insert(aBoard(id = Uuid.generateV7(), deletedAt = FIXED_NOW))

            val view = service.listTrash(asUser(OWNER))

            assertEquals(listOf(folder.id), view.folders.map { it.id }, "one entry for the folder")
            assertEquals(listOf(single.id), view.boards.map { it.id }, "the board inside is not listed on its own")
        }
    }

    @Nested
    inner class Restore {

        @Test
        fun `when restoring a board whose folder is in the trash then it lands in the root`() = runTest {
            val folder = folders.insert(aFolder(deletedAt = FIXED_NOW))
            val board = boards.insert(aBoard(id = Uuid.generateV7(), folderId = folder.id, deletedAt = FIXED_NOW - 1.days))

            val view = service.restoreBoard(asUser(OWNER), board.id)

            assertNull(view.board.folderId, "root")
            assertNull(view.board.deletedAt, "out of the trash")
        }

        @Test
        fun `when restoring a folder then what was deleted with it comes back but an earlier deletion stays`() = runTest {
            val folder = folders.insert(aFolder(deletedAt = FIXED_NOW))
            val together = boards.insert(aBoard(id = Uuid.generateV7(), folderId = folder.id, deletedAt = FIXED_NOW))
            val earlier = boards.insert(aBoard(id = Uuid.generateV7(), folderId = folder.id, deletedAt = FIXED_NOW - 3.days))

            service.restoreFolder(asUser(OWNER), folder.id)

            assertNull(boards.findById(together.id)?.deletedAt, "restored with the folder")
            assertEquals(FIXED_NOW - 3.days, boards.findById(earlier.id)?.deletedAt, "individually deleted earlier: stays in the trash")
        }

        @Test
        fun `when restoring a board that is not in the trash then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val board = boards.insert(aBoard(id = Uuid.generateV7()))

            val failure = assertFailsWith<DomainException>("not trashed") { service.restoreBoard(asUser(OWNER), board.id) }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "error code")
        }

        @Test
        fun `when restoring the board of someone else then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val board = boards.insert(aBoard(id = Uuid.generateV7(), deletedAt = FIXED_NOW))

            val failure = assertFailsWith<DomainException>("foreign") { service.restoreBoard(asUser(STRANGER), board.id) }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "existence is not revealed")
        }
    }

    @Nested
    inner class Purge {

        @Test
        fun `when purging a folder then it, its subfolders and its boards are deleted and the board ids come back`() = runTest {
            val folder = folders.insert(aFolder(deletedAt = FIXED_NOW))
            val child = folders.insert(aFolder(parent = folder.id, deletedAt = FIXED_NOW))
            val board = boards.insert(aBoard(id = Uuid.generateV7(), folderId = child.id, deletedAt = FIXED_NOW))

            val gone = service.purgeFolder(asUser(OWNER), folder.id)

            assertEquals(listOf(board.id), gone, "board ids for the collab clean-up")
            assertEquals(emptyList(), folders.all.map { it.id }, "folders gone")
            assertEquals(emptyList(), boards.all.map { it.id }, "boards gone")
            assertEquals("library.folder.purged", audit.events.single().eventType, "audit")
        }

        @Test
        fun `when purging a board that is not in the trash then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val board = boards.insert(aBoard(id = Uuid.generateV7()))

            assertFailsWith<DomainException>("alive") { service.purgeBoard(asUser(OWNER), board.id) }
        }

        @Test
        fun `when the cleanup runs then only items deleted before the limit are purged`() = runTest {
            val old = boards.insert(aBoard(id = Uuid.generateV7(), deletedAt = FIXED_NOW - 31.days))
            val young = boards.insert(aBoard(id = Uuid.generateV7(), deletedAt = FIXED_NOW - 2.days))
            val oldFolder = folders.insert(aFolder(deletedAt = FIXED_NOW - 40.days))
            val inOldFolder = boards.insert(aBoard(id = Uuid.generateV7(), folderId = oldFolder.id, deletedAt = FIXED_NOW - 40.days))

            val gone = service.purgeExpired(FIXED_NOW - 30.days)

            assertEquals(setOf(old.id, inOldFolder.id), gone.toSet(), "expired boards, also the one in the expired folder")
            assertEquals(listOf(young.id), boards.all.map { it.id }, "the young one stays")
            assertEquals(emptyList(), folders.all, "expired folder purged")
        }
    }
}
