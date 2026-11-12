package at.dergeorg.drawboard.library.domain.trash.provides.impl

import at.dergeorg.drawboard.library.domain.trash.ResourceEraser

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.domain.access.LibraryErrors
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.model.BoardPurged
import at.dergeorg.drawboard.library.domain.boards.model.BoardRestored
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.FolderTree
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.model.FolderPurged
import at.dergeorg.drawboard.library.domain.folders.model.FolderRestored
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import at.dergeorg.drawboard.library.domain.trash.provides.TrashView
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the trash use cases. Purging deletes the rows for good; the audit event stays (S7.1). */
@Service
internal class TrashService(
    private val boards: BoardRepository,
    private val folders: FolderRepository,
    private val eraser: ResourceEraser,
    private val audit: AuditTrail,
    private val clock: Clock,
) : TrashUseCase {

    private val events = DomainEvents(LibraryModule.NAME)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listTrash(caller: Caller): TrashView {
        val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
        val allFolders = folders.findAllByOwner(user.id).associateBy { it.id }
        val deletedFolders = allFolders.values.filter { it.deletedAt != null }
        // One entry per deletion: skip what went to the trash together with its (deleted) parent.
        val rootFolders = deletedFolders.filter { f -> allFolders[f.parentId]?.deletedAt != f.deletedAt }
        val rootBoards = boards.findDeletedByOwner(user.id).filter { b -> allFolders[b.folderId]?.deletedAt != b.deletedAt }
        return TrashView(rootBoards.sortedByDescending { it.deletedAt }, rootFolders.sortedByDescending { it.deletedAt })
    }

    @WithSpan
    @Transactional
    override suspend fun restoreBoard(caller: Caller, @SpanAttribute("board.id") boardId: Uuid): BoardView {
        val board = ownTrashedBoard(caller, boardId)
        val folder = board.folderId?.let { folders.findById(it) }
        val toRoot = board.folderId != null && (folder == null || folder.deletedAt != null)
        val restored = boards.update(
            board.copy(deletedAt = null, folderId = if (toRoot) null else board.folderId, updatedAt = clock.now()),
        ) ?: throw LibraryErrors.conflict("board", boardId, board.version)
        audit.record(events.of(BOARD, boardId, AuditAction.UPDATED, "restored", BoardRestored(toRoot), before = board, after = restored))
        return BoardView(restored, BoardRole.OWNER)
    }

    @WithSpan
    @Transactional
    override suspend fun restoreFolder(caller: Caller, @SpanAttribute("folder.id") folderId: Uuid): FolderView {
        val folder = ownTrashedFolder(caller, folderId)
        val all = folders.findAllByOwner(folder.ownerId)
        val parent = folder.parentId?.let { id -> all.firstOrNull { it.id == id } }
        val toRoot = folder.parentId != null && (parent == null || parent.deletedAt != null)
        val together = FolderTree.subtree(folder, all).filter { it.id != folder.id && it.deletedAt == folder.deletedAt }
        val belowBoards = boards.findAllInFolders(together.map { it.id } + folder.id).filter { it.deletedAt == folder.deletedAt }
        val restored = folders.update(
            folder.copy(deletedAt = null, parentId = if (toRoot) null else folder.parentId, updatedAt = clock.now()),
        ) ?: throw LibraryErrors.conflict("folder", folderId, folder.version)
        folders.setDeletedAt(together.map { it.id }, null)
        boards.setDeletedAt(belowBoards.map { it.id }, null)
        audit.record(
            events.of(
                FOLDER, folderId, AuditAction.UPDATED, "restored",
                FolderRestored(together.size, belowBoards.size, toRoot), folder, restored,
            ),
        )
        return FolderView(restored, BoardRole.OWNER)
    }

    @WithSpan
    @Transactional
    override suspend fun purgeBoard(caller: Caller, @SpanAttribute("board.id") boardId: Uuid): List<Uuid> {
        val board = ownTrashedBoard(caller, boardId)
        eraser.erase(boardIds = listOf(boardId), folderIds = emptyList())
        audit.record(events.of(BOARD, boardId, AuditAction.DELETED, "purged", BoardPurged(automatic = false), before = board))
        return listOf(boardId)
    }

    @WithSpan
    @Transactional
    override suspend fun purgeFolder(caller: Caller, @SpanAttribute("folder.id") folderId: Uuid): List<Uuid> {
        val folder = ownTrashedFolder(caller, folderId)
        return purgeTree(folder, automatic = false)
    }

    @WithSpan
    @Transactional
    override suspend fun purgeExpired(deletedBefore: Instant): List<Uuid> {
        val gone = LinkedHashSet<Uuid>()
        val goneFolders = HashSet<Uuid>()
        for (folder in folders.findDeletedBefore(deletedBefore)) {
            if (folder.id in goneFolders) continue
            purgeTree(folder, automatic = true).also(gone::addAll)
            goneFolders += FolderTree.subtree(folder, folders.findAllByOwner(folder.ownerId)).map { it.id }
        }
        for (board in boards.findDeletedBefore(deletedBefore)) {
            if (board.id in gone || boards.findById(board.id) == null) continue
            eraser.erase(boardIds = listOf(board.id), folderIds = emptyList())
            audit.record(events.of(BOARD, board.id, AuditAction.DELETED, "purged", BoardPurged(automatic = true), before = board))
            gone += board.id
        }
        return gone.toList()
    }

    private suspend fun purgeTree(folder: Folder, automatic: Boolean): List<Uuid> {
        val tree = FolderTree.subtree(folder, folders.findAllByOwner(folder.ownerId))
        val treeBoards = boards.findAllInFolders(tree.map { it.id })
        eraser.erase(boardIds = treeBoards.map { it.id }, folderIds = tree.map { it.id })
        audit.record(
            events.of(
                FOLDER, folder.id, AuditAction.DELETED, "purged",
                FolderPurged(tree.size - 1, treeBoards.size, automatic), before = folder,
            ),
        )
        return treeBoards.map { it.id }
    }

    private suspend fun ownTrashedBoard(caller: Caller, id: Uuid): Board {
        val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
        return boards.findById(id)?.takeIf { it.deletedAt != null && it.ownerId == user.id } ?: throw LibraryErrors.boardNotFound(id)
    }

    private suspend fun ownTrashedFolder(caller: Caller, id: Uuid): Folder {
        val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
        return folders.findById(id)?.takeIf { it.deletedAt != null && it.ownerId == user.id } ?: throw LibraryErrors.folderNotFound(id)
    }

    private companion object {
        const val BOARD = "board"
        const val FOLDER = "folder"
    }
}
