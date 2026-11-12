package at.dergeorg.drawboard.api.domain.files.files.provides.impl

import at.dergeorg.drawboard.api.domain.files.files.provides.FilesApiUseCase
import at.dergeorg.drawboard.contract.api.FilesApi
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.FileUrlList
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.http.codec.multipart.Part
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [FilesApi] and delegates to [FilesApiUseCase]. "Signed in" (and "not a guest" for
 * upload and delete) is the business of the route table in core; the role on the board is checked by the use case.
 * The bytes of a file are NOT served here - see [FileContentController].
 */
@RestController
internal class FilesController(
    private val files: FilesApiUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
) : FilesApi {

    @WithSpan
    override suspend fun listFiles(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<BoardFileList> =
        ResponseEntity.ok(files.listFiles(boardId))

    @WithSpan
    override suspend fun uploadFile(@SpanAttribute("board.id") boardId: Uuid, file: Part): ResponseEntity<BoardFile> {
        val created = files.uploadFile(boardId, file)
        val location = UriComponentsBuilder.fromPath(basePath).path(FilesApi.PATH_GET_FILE).buildAndExpand(boardId, created.id).toUri()
        return ResponseEntity.created(location).body(created)
    }

    @WithSpan
    override suspend fun getFileUrls(ids: String, @SpanAttribute("board.id") boardId: Uuid): ResponseEntity<FileUrlList> =
        // the URLs are signatures: nothing may keep this answer (S4.4)
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(files.getFileUrls(boardId, ids))

    @WithSpan
    override suspend fun getFile(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("file.id") fileId: Uuid,
    ): ResponseEntity<BoardFile> =
        ResponseEntity.ok(files.getFile(boardId, fileId))

    @WithSpan
    override suspend fun deleteFile(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("file.id") fileId: Uuid,
    ): ResponseEntity<Unit> {
        files.deleteFile(boardId, fileId)
        return ResponseEntity.noContent().build()
    }
}
