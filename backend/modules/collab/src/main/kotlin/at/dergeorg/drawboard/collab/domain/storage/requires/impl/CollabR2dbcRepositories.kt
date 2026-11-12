package at.dergeorg.drawboard.collab.domain.storage.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.r2dbc.repository.Query
import org.springframework.data.repository.query.Param
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.uuid.Uuid

/**
 * Spring Data R2DBC repository of the update log. Derived queries only, except the sum of the sizes: a derived query
 * cannot aggregate, and loading the rows to add them up would read up to 100 MB. The one `@Query` of the application
 * (ArchitectureTest names the two repositories with a sum as the exception).
 */
internal interface UpdateR2dbcRepository : CoroutineCrudRepository<UpdateEntity, Uuid> {

    fun findAllByBoardIdAndSeqGreaterThanOrderBySeqAsc(boardId: Uuid, seq: Long): Flow<UpdateEntity>

    suspend fun countByBoardIdAndSeqGreaterThan(boardId: Uuid, seq: Long): Long

    suspend fun deleteByBoardIdAndSeqLessThanEqual(boardId: Uuid, seq: Long): Long

    suspend fun deleteByBoardId(boardId: Uuid): Long

    @Query("SELECT COALESCE(SUM(size), 0) FROM collab.board_update WHERE board_id = :boardId AND seq > :seq")
    suspend fun sumSizeAfter(@Param("boardId") boardId: Uuid, @Param("seq") seq: Long): Long

    @Query("SELECT COALESCE(SUM(size), 0) FROM collab.board_update")
    suspend fun sumSize(): Long
}

/** Metadata view of the log ([UpdateRowEntity]): never loads the bytes. */
internal interface UpdateRowR2dbcRepository : CoroutineCrudRepository<UpdateRowEntity, Uuid> {

    suspend fun findFirstByBoardIdOrderBySeqDesc(boardId: Uuid): UpdateRowEntity?
}

internal interface SnapshotR2dbcRepository : CoroutineCrudRepository<SnapshotEntity, Uuid> {

    suspend fun findFirstByBoardIdOrderByUpToSeqDesc(boardId: Uuid): SnapshotEntity?

    suspend fun deleteByBoardId(boardId: Uuid): Long

    /** Same reason as [UpdateR2dbcRepository.sumSizeAfter]: the storage metric adds up megabytes the database already counted. */
    @Query("SELECT COALESCE(SUM(size), 0) FROM collab.board_snapshot")
    suspend fun sumSize(): Long
}

/** Metadata view of the snapshots ([SnapshotMetaEntity]): never loads the bytes. */
internal interface SnapshotMetaR2dbcRepository : CoroutineCrudRepository<SnapshotMetaEntity, Uuid> {

    suspend fun findAllByBoardIdOrderByUpToSeqDesc(boardId: Uuid): List<SnapshotMetaEntity>
}
