package at.dergeorg.drawboard.api.domain.files

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.domain.files.files.provides.FilesApiUseCase
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileConversion
import at.dergeorg.drawboard.contract.model.BoardFileKind
import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.FileUrl
import at.dergeorg.drawboard.contract.model.FileUrlList
import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase
import at.dergeorg.drawboard.files.domain.files.provides.UploadCommand
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactive.asFlow
import org.springframework.core.io.buffer.DataBufferUtils
import org.springframework.http.codec.multipart.FilePart
import org.springframework.http.codec.multipart.Part
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the API use cases of the files module: the files of a board are visible to everyone who can see the board
 * (guests of its link included, S1.8) and changeable by its editors and owners who are signed in - never by guests
 * (S1.9). The files module trusts this check and never sees a token, a role or a board; this is where the two meet.
 */
@Service
internal class FilesApiService(
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val files: FilesUseCase,
) : FilesApiUseCase {

    @WithSpan
    override suspend fun listFiles(@SpanAttribute("board.id") boardId: Uuid): BoardFileList {
        requireView(boardId)
        val hideAuthors = callers.guestOrNull() != null
        return BoardFileList(items = files.listFiles(boardId).map { it.toContract(includeAuthor = !hideAuthors) })
    }

    @WithSpan
    override suspend fun getFile(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("file.id") fileId: Uuid): BoardFile {
        requireView(boardId)
        val hideAuthors = callers.guestOrNull() != null
        return files.getFile(boardId, fileId).toContract(includeAuthor = !hideAuthors)
    }

    @WithSpan
    override suspend fun getFileUrls(@SpanAttribute("board.id") boardId: Uuid, ids: String): FileUrlList {
        requireView(boardId)
        val wanted = ids.split(',').map { Uuid.parse(it.trim()) }
        val issued = files.issueUrls(boardId, wanted)
        return FileUrlList(
            items = issued.items.map {
                FileUrl(
                    fileId = it.fileId,
                    url = it.url,
                    originalUrl = it.originalUrl,
                    expiresAt = issued.expiresAt,
                    thumbnailUrl = it.thumbnailUrl,
                    pdfUrl = it.pdfUrl,
                )
            },
        )
    }

    @WithSpan
    override suspend fun uploadFile(@SpanAttribute("board.id") boardId: Uuid, file: Part): BoardFile {
        val uploader = requireEdit(boardId)
        // the part must be a file: a plain form field named "file" is a client error
        val filePart = file as? FilePart
            ?: throw ValidationFailedException(listOf(InvalidField("file", "NotFile", "must be a file")))
        return files.upload(
            UploadCommand(boardId, uploader, filePart.filename(), filePart.content().asChunks()),
        ).toContract(includeAuthor = true)
    }

    @WithSpan
    override suspend fun deleteFile(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("file.id") fileId: Uuid) {
        requireEdit(boardId)
        files.deleteFile(boardId, fileId)
    }

    /** Any role on the board counts (a guest's role is the one of its link); no role: the board does not exist for the caller. */
    private suspend fun requireView(boardId: Uuid) {
        boards.roleOf(callers.any(), boardId) ?: throw boardNotFound(boardId)
    }

    /** Editor or owner, signed in. The route table already turned guests away; this is the safety net. Returns the user's id. */
    private suspend fun requireEdit(boardId: Uuid): Uuid {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
        val caller = signedIn.caller()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (role != BoardRole.OWNER && role != BoardRole.EDITOR) {
            throw DomainException(
                ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to boardId.toString(), "required" to "EDITOR or OWNER"),
            )
        }
        return caller.id
    }

    private fun boardNotFound(boardId: Uuid) = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))

    /** The body of the part as chunks; every buffer is copied and released at once, so nothing piles up. */
    private fun Flow<org.springframework.core.io.buffer.DataBuffer>.asChunks(): Flow<ByteArray> = map { buffer ->
        try {
            ByteArray(buffer.readableByteCount()).also(buffer::read)
        } finally {
            DataBufferUtils.release(buffer)
        }
    }

    private fun reactor.core.publisher.Flux<org.springframework.core.io.buffer.DataBuffer>.asChunks(): Flow<ByteArray> = asFlow().asChunks()

    private fun StoredFile.toContract(includeAuthor: Boolean) = BoardFile(
        id = id,
        boardId = boardId,
        name = name,
        mediaType = mediaType,
        kind = when (kind) {
            FileKind.IMAGE -> BoardFileKind.IMAGE
            FileKind.VIDEO -> BoardFileKind.VIDEO
            FileKind.PDF -> BoardFileKind.PDF
            FileKind.DOCUMENT -> BoardFileKind.DOCUMENT
        },
        size = size,
        createdAt = createdAt,
        conversion = when (conversion) {
            Conversion.NONE -> BoardFileConversion.NONE
            Conversion.PENDING -> BoardFileConversion.PENDING
            Conversion.DONE -> BoardFileConversion.DONE
            Conversion.FAILED -> BoardFileConversion.FAILED
        },
        createdBy = createdBy.takeIf { includeAuthor }, // guests must not collect the user ids of members
        pageCount = pageCount,
        width = width,
        height = height,
    )
}
