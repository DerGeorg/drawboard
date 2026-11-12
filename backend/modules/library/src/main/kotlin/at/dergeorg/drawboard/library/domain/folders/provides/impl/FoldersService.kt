package at.dergeorg.drawboard.library.domain.folders.provides.impl

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.LibraryErrors
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.model.FolderCreated
import at.dergeorg.drawboard.library.domain.folders.model.FolderDeleted
import at.dergeorg.drawboard.library.domain.folders.model.FolderUpdated
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import at.dergeorg.drawboard.library.domain.folders.provides.CreateFolderCommand
import at.dergeorg.drawboard.library.domain.folders.FolderTree
import at.dergeorg.drawboard.library.domain.folders.provides.FoldersUseCase
import at.dergeorg.drawboard.library.domain.folders.provides.UpdateFolderCommand
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.uuid.Uuid

/** Implements the folder use cases. Same transaction rule as [at.dergeorg.drawboard.library.domain.LibraryService]. */
@Service
internal class FoldersService(
    private val folders: FolderRepository,
    private val boards: BoardRepository,
    private val access: AccessResolver,
    private val audit: AuditTrail,
    private val clock: Clock,
) : FoldersUseCase {

    private val events = DomainEvents(LibraryModule.NAME)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listFolders(caller: Caller, @SpanAttribute("folder.id") parentId: Uuid?): List<FolderView> {
        if (parentId == null) {
            val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
            return folders.findAllByOwner(user.id).filter { it.deletedAt == null }.sortedBy { it.name.lowercase() }
                .map { FolderView(it, BoardRole.OWNER) }
        }
        val parent = visible(parentId)
        val parentRole = access.folderRole(parent, caller) ?: throw LibraryErrors.folderNotFound(parentId)
        return folders.findAllByOwner(parent.ownerId).filter { it.parentId == parentId && it.deletedAt == null }
            .sortedBy { it.name.lowercase() }
            .map { FolderView(it, access.folderRole(it, caller) ?: parentRole) }
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun getFolder(caller: Caller, @SpanAttribute("folder.id") folderId: Uuid): FolderView {
        val folder = visible(folderId)
        return FolderView(folder, access.folderRole(folder, caller) ?: throw LibraryErrors.folderNotFound(folderId))
    }

    @WithSpan
    @Transactional
    override suspend fun createFolder(command: CreateFolderCommand): FolderView {
        val name = LibraryErrors.validText("name", command.name, Folder.MAX_NAME_LENGTH)
        command.parentId?.let { ownFolder(it, command.ownerId) }
        val now = clock.now()
        val folder = folders.insert(
            Folder(
                id = Uuid.generateV7(), name = name, ownerId = command.ownerId, parentId = command.parentId,
                createdAt = now, updatedAt = now,
            ),
        )
        audit.record(events.created(FOLDER, folder.id, after = folder, details = FolderCreated(submittedName = command.name)))
        return FolderView(folder, BoardRole.OWNER)
    }

    @WithSpan
    @Transactional
    override suspend fun updateFolder(command: UpdateFolderCommand): FolderView {
        val name = LibraryErrors.validText("name", command.name, Folder.MAX_NAME_LENGTH)
        val folder = visible(command.folderId)
        val role = access.folderRole(folder, command.caller) ?: throw LibraryErrors.folderNotFound(folder.id)
        requireOwner(role)
        if (folder.version != command.version) throw conflict(folder)
        if (command.parentId != null) {
            ownFolder(command.parentId, folder.ownerId)
            val below = FolderTree.subtree(folder, folders.findAllByOwner(folder.ownerId)).map { it.id }.toSet()
            if (command.parentId in below) throw DomainException(ErrorCode.LIBRARY_FOLDER_CYCLE, mapOf("folderId" to folder.id.toString()))
        }
        if (folder.name == name && folder.parentId == command.parentId) return FolderView(folder, role)

        val updated = folders.update(folder.copy(name = name, parentId = command.parentId, updatedAt = clock.now()))
            ?: throw conflict(visible(folder.id))
        val details = FolderUpdated(submittedName = command.name, parentId = command.parentId?.toString(), basedOnVersion = command.version)
        audit.record(events.updated(FOLDER, folder.id, before = folder, after = updated, details = details))
        return FolderView(updated, role)
    }

    @WithSpan
    @Transactional
    override suspend fun deleteFolder(caller: Caller, @SpanAttribute("folder.id") folderId: Uuid): List<Uuid> {
        val folder = visible(folderId)
        requireOwner(access.folderRole(folder, caller) ?: throw LibraryErrors.folderNotFound(folderId))
        val now = clock.now()
        // The folder and everything below get the same instant: that is how a restore finds what belonged to the deletion.
        val below = FolderTree.subtree(folder, folders.findAllByOwner(folder.ownerId)).filter { it.id != folder.id && it.deletedAt == null }
        val belowBoards = boards.findAllInFolders(below.map { it.id } + folder.id).filter { it.deletedAt == null }
        folders.update(folder.copy(deletedAt = now, updatedAt = now)) ?: throw conflict(visible(folderId))
        folders.setDeletedAt(below.map { it.id }, now)
        boards.setDeletedAt(belowBoards.map { it.id }, now)

        val details = FolderDeleted(folders = below.size, boards = belowBoards.size)
        audit.record(events.deleted(FOLDER, folderId, before = folder, details = details))
        return belowBoards.map { it.id }
    }

    /** A folder that exists and is not in the trash. */
    private suspend fun visible(id: Uuid): Folder =
        folders.findById(id)?.takeIf { it.deletedAt == null } ?: throw LibraryErrors.folderNotFound(id)

    private suspend fun ownFolder(id: Uuid, ownerId: Uuid): Folder =
        folders.findById(id)?.takeIf { it.ownerId == ownerId && it.deletedAt == null } ?: throw LibraryErrors.folderNotFound(id)

    /** Managing folders is the owner's alone: any other role is `FORBIDDEN`. */
    private fun requireOwner(role: BoardRole) {
        if (role != BoardRole.OWNER) throw DomainException(ErrorCode.FORBIDDEN)
    }

    private fun conflict(current: Folder) = LibraryErrors.conflict("folder", current.id, current.version)

    private companion object {
        const val FOLDER = "folder"
    }
}
