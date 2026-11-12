package at.dergeorg.drawboard.api.domain.library.folders.provides

import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.FolderList
import at.dergeorg.drawboard.contract.model.FolderUpdate
import at.dergeorg.drawboard.contract.model.NewFolder
import kotlin.uuid.Uuid

/** The folders part of the API in contract types (including the folders in the trash). */
interface FoldersApiUseCase {

    suspend fun listFolders(parentId: Uuid?): FolderList

    suspend fun getFolder(folderId: Uuid): Folder

    suspend fun createFolder(newFolder: NewFolder): Folder

    suspend fun updateFolder(folderId: Uuid, folderUpdate: FolderUpdate): Folder

    suspend fun deleteFolder(folderId: Uuid)

    suspend fun restoreFolder(folderId: Uuid): Folder

    suspend fun purgeFolder(folderId: Uuid)
}
