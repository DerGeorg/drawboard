package at.dergeorg.drawboard.files.domain.files.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.r2dbc.repository.Query
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import org.springframework.data.repository.query.Param
import kotlin.uuid.Uuid

/**
 * Spring Data R2DBC repository, derived queries only - except the two sums of the quotas: a derived query cannot add up,
 * and loading every row of a user to add the sizes would read thousands of rows per upload (ArchitectureTest names this
 * repository as an exception, like the two sums of collab). The sums are the bytes on the volume that belong to the quota:
 * originals plus converted PDFs (M3 backend review, SHOULD 7). Thumbnails are not stored with a size: at most 512 px, a few
 * dozen KiB each, they stay outside.
 */
internal interface FileR2dbcRepository : CoroutineCrudRepository<FileEntity, Uuid> {

    fun findAllByBoardIdOrderByCreatedAtDescIdDesc(boardId: Uuid): Flow<FileEntity>

    fun findAllByBoardIdIn(boardIds: Collection<Uuid>): Flow<FileEntity>

    fun findAllByConversion(conversion: String): Flow<FileEntity>

    suspend fun countByBoardId(boardId: Uuid): Long

    @Query("SELECT COALESCE(SUM(size), 0) + COALESCE(SUM(pdf_size), 0) FROM files.board_file WHERE board_id = :boardId")
    suspend fun sumSizeOfBoard(@Param("boardId") boardId: Uuid): Long

    @Query("SELECT COALESCE(SUM(size), 0) + COALESCE(SUM(pdf_size), 0) FROM files.board_file WHERE created_by = :userId")
    suspend fun sumSizeOfUser(@Param("userId") userId: Uuid): Long

    @Query("SELECT COALESCE(SUM(size), 0) + COALESCE(SUM(pdf_size), 0) FROM files.board_file")
    suspend fun sumSizeOfAll(): Long
}
