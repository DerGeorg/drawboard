package at.dergeorg.drawboard.api.domain.library

import at.dergeorg.drawboard.api.common.BoardDataEraser
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.common.toApi
import at.dergeorg.drawboard.api.domain.library.folders.provides.FoldersApiUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.FolderList
import at.dergeorg.drawboard.contract.model.FolderUpdate
import at.dergeorg.drawboard.contract.model.NewFolder
import at.dergeorg.drawboard.library.domain.folders.provides.CreateFolderCommand
import at.dergeorg.drawboard.library.domain.folders.provides.FoldersUseCase
import at.dergeorg.drawboard.library.domain.folders.provides.UpdateFolderCommand
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/** Implements the API use cases of the folders: contract types in, library use cases, contract types out. */
@Service
internal class FoldersApiService(
    private val signedIn: SignedInUsers,
    private val folders: FoldersUseCase,
    private val trash: TrashUseCase,
    private val collab: CollabUseCase,
    private val eraser: BoardDataEraser,
) : FoldersApiUseCase {

    @WithSpan
    override suspend fun listFolders(@SpanAttribute("folder.id") parentId: Uuid?): FolderList =
        FolderList(items = folders.listFolders(signedIn.caller(), parentId).map { it.toApi() })

    @WithSpan
    override suspend fun getFolder(@SpanAttribute("folder.id") folderId: Uuid): Folder =
        folders.getFolder(signedIn.caller(), folderId).toApi()

    @WithSpan
    override suspend fun createFolder(newFolder: NewFolder): Folder =
        folders.createFolder(
            CreateFolderCommand(ownerId = signedIn.caller().id, name = newFolder.name, parentId = newFolder.parentId),
        ).toApi()

    @WithSpan
    override suspend fun updateFolder(@SpanAttribute("folder.id") folderId: Uuid, folderUpdate: FolderUpdate): Folder {
        val command = UpdateFolderCommand(
            caller = signedIn.caller(),
            folderId = folderId,
            name = folderUpdate.name,
            parentId = folderUpdate.parentId,
            version = folderUpdate.version,
        )
        val updated = folders.updateFolder(command).toApi()
        // Moving changes which inherited grants apply below the folder.
        collab.recheckAll()
        return updated
    }

    @WithSpan
    override suspend fun deleteFolder(@SpanAttribute("folder.id") folderId: Uuid) {
        folders.deleteFolder(signedIn.caller(), folderId).forEach { collab.closeSessions(it) }
    }

    @WithSpan
    override suspend fun restoreFolder(@SpanAttribute("folder.id") folderId: Uuid): Folder =
        trash.restoreFolder(signedIn.caller(), folderId).toApi()

    @WithSpan
    override suspend fun purgeFolder(@SpanAttribute("folder.id") folderId: Uuid) {
        eraser.erase(trash.purgeFolder(signedIn.caller(), folderId))
    }
}
