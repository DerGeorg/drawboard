package at.dergeorg.drawboard.library.domain.folders.provides

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import kotlin.uuid.Uuid

/**
 * Folders of the personal spaces. A folder the caller has no role on is `LIBRARY_FOLDER_NOT_FOUND` (never "forbidden"),
 * a role that is too weak `FORBIDDEN`. Managing folders is the owner's alone. Every change is audited in the same
 * transaction.
 */
interface FoldersUseCase {

    /** Without [parentId]: every folder the caller owns, flat. With it: the folders directly below it (role VIEWER needed). */
    suspend fun listFolders(caller: Caller, parentId: Uuid?): List<FolderView>

    suspend fun getFolder(caller: Caller, folderId: Uuid): FolderView

    /** The creator becomes the owner; [CreateFolderCommand.parentId] must be one of their folders. */
    suspend fun createFolder(command: CreateFolderCommand): FolderView

    /** Rename and move; `LIBRARY_FOLDER_CYCLE` when moved into itself or below itself, `CONFLICT` on an outdated version. */
    suspend fun updateFolder(command: UpdateFolderCommand): FolderView

    /** To the trash, with everything below. Returns the boards that went with it (their sessions must be closed). */
    suspend fun deleteFolder(caller: Caller, folderId: Uuid): List<Uuid>
}

data class CreateFolderCommand(val ownerId: Uuid, val name: String, val parentId: Uuid?)

data class UpdateFolderCommand(val caller: Caller, val folderId: Uuid, val name: String, val parentId: Uuid?, val version: Long)
