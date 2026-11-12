package at.dergeorg.drawboard.files.domain.files.provides

import at.dergeorg.drawboard.files.domain.files.model.FileDownload
import at.dergeorg.drawboard.files.domain.files.model.IssuedUrls
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import kotlinx.coroutines.flow.Flow
import kotlin.uuid.Uuid

/**
 * What the files module offers: the files of a board (S4). Access is decided by the CALLER (module `api`): it checks the
 * role on the board first - the files module does not know boards, roles or tokens (modules never know each other).
 * Every function takes the board and only ever sees the files of that board: a file of another board is
 * `FILES_FILE_NOT_FOUND`, never "forbidden".
 */
interface FilesUseCase {

    /**
     * Stores the upload (S4.1-S4.3, S4.8): streamed with a hard byte cap, the type detected from the content, the
     * extension checked, the quotas and the rate limits applied. Nothing is stored when any check fails. Audited.
     */
    suspend fun upload(command: UploadCommand): StoredFile

    /** The files of the board, newest first. */
    suspend fun listFiles(boardId: Uuid): List<StoredFile>

    suspend fun getFile(boardId: Uuid, fileId: Uuid): StoredFile

    /** Deletes the file with all its variants for good. Audited. */
    suspend fun deleteFile(boardId: Uuid, fileId: Uuid)

    /** Signed URLs (valid at most one hour) for those of [ids] that are files of the board, in the order of [ids]. */
    suspend fun issueUrls(boardId: Uuid, ids: List<Uuid>): IssuedUrls

    /**
     * Verifies the signed URL and opens the variant (S4.4, S4.7): `FILES_URL_INVALID` for every verification failure
     * (same answer), then `FILES_FILE_NOT_FOUND`, then 416 for a bad range. No board, no user: the signature authorises.
     */
    suspend fun open(command: OpenFileCommand): FileDownload

    /** Deletes every file of the boards that were purged for good (S7.7); returns how many files were removed. */
    suspend fun deleteBoardData(boardIds: Collection<Uuid>): Int
}

/** Input of [FilesUseCase.upload]: [fileName] is the name the client gave the part (untrusted), [content] the bytes. */
class UploadCommand(val boardId: Uuid, val uploaderId: Uuid, val fileName: String?, val content: Flow<ByteArray>)

/** Input of [FilesUseCase.open]: the parts of the signed URL, as received, and the `Range` header if there is one. */
class OpenFileCommand(val fileId: Uuid, val variant: String, val exp: Long, val signature: String, val range: String?)
