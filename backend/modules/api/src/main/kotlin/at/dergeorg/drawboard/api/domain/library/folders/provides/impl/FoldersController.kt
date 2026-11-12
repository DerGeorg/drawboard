package at.dergeorg.drawboard.api.domain.library.folders.provides.impl

import at.dergeorg.drawboard.api.domain.library.folders.provides.FoldersApiUseCase
import at.dergeorg.drawboard.contract.api.FoldersApi
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.FolderList
import at.dergeorg.drawboard.contract.model.FolderUpdate
import at.dergeorg.drawboard.contract.model.NewFolder
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder
import kotlin.uuid.Uuid

/** HTTP only: implements the generated [FoldersApi], sets status codes and headers, delegates to [FoldersApiUseCase]. */
@RestController
internal class FoldersController(
    private val folders: FoldersApiUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
) : FoldersApi {

    @WithSpan
    override suspend fun listFolders(@SpanAttribute("folder.id") parentId: Uuid?): ResponseEntity<FolderList> =
        ResponseEntity.ok(folders.listFolders(parentId))

    @WithSpan
    override suspend fun getFolder(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<Folder> =
        ResponseEntity.ok(folders.getFolder(folderId))

    @WithSpan
    override suspend fun createFolder(newFolder: NewFolder): ResponseEntity<Folder> {
        val created = folders.createFolder(newFolder)
        val location = UriComponentsBuilder.fromPath(basePath).path(FoldersApi.PATH_GET_FOLDER).buildAndExpand(created.id).toUri()
        return ResponseEntity.created(location).body(created)
    }

    @WithSpan
    override suspend fun updateFolder(@SpanAttribute("folder.id") folderId: Uuid, folderUpdate: FolderUpdate): ResponseEntity<Folder> =
        ResponseEntity.ok(folders.updateFolder(folderId, folderUpdate))

    @WithSpan
    override suspend fun deleteFolder(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<Unit> {
        folders.deleteFolder(folderId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun restoreFolder(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<Folder> =
        ResponseEntity.ok(folders.restoreFolder(folderId))

    @WithSpan
    override suspend fun purgeFolder(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<Unit> {
        folders.purgeFolder(folderId)
        return ResponseEntity.noContent().build()
    }
}
