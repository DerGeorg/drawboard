package at.dergeorg.drawboard.files.domain.files.requires

import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import kotlin.uuid.Uuid

/** Port: where the metadata of the files is kept. */
internal interface FileRepository {

    suspend fun findById(id: Uuid): StoredFile?

    /** The files of a board, newest first. */
    suspend fun findByBoard(boardId: Uuid): List<StoredFile>

    suspend fun findByBoards(boardIds: Collection<Uuid>): List<StoredFile>

    suspend fun findByConversion(state: Conversion): List<StoredFile>

    suspend fun countByBoard(boardId: Uuid): Long

    /** The bytes the quota counts for the files of the board / uploaded by the user: `size` of the originals plus `pdfSize` of the converted PDFs. */
    suspend fun usedBytesOfBoard(boardId: Uuid): Long

    suspend fun usedBytesOfUser(userId: Uuid): Long

    /** Every byte the files of all boards occupy (originals and converted PDFs) - for the gauge `drawboard.storage.bytes{kind="files"}`. */
    suspend fun totalBytes(): Long

    /** [file] must have no version: a new row. */
    suspend fun insert(file: StoredFile): StoredFile

    /** Writes [file] based on its version; null if the row changed or is gone in between. */
    suspend fun update(file: StoredFile): StoredFile?

    /** The ids among [ids] that have a row - for the orphan sweep. */
    suspend fun existing(ids: Collection<Uuid>): Set<Uuid>

    suspend fun deleteByIds(ids: Collection<Uuid>)
}
