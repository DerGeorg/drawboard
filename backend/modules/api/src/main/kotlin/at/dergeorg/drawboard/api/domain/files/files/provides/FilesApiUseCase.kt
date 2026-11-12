package at.dergeorg.drawboard.api.domain.files.files.provides

import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.FileUrlList
import org.springframework.http.codec.multipart.Part
import kotlin.uuid.Uuid

/** The files part of the API in contract types. The controller does HTTP, this checks the board access and calls the files module. */
interface FilesApiUseCase {

    suspend fun listFiles(boardId: Uuid): BoardFileList

    suspend fun uploadFile(boardId: Uuid, file: Part): BoardFile

    suspend fun getFileUrls(boardId: Uuid, ids: String): FileUrlList

    suspend fun getFile(boardId: Uuid, fileId: Uuid): BoardFile

    suspend fun deleteFile(boardId: Uuid, fileId: Uuid)
}
