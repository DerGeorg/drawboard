package at.dergeorg.drawboard.library.domain.boards.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.domain.Pageable
import org.springframework.data.relational.core.sql.LockMode
import org.springframework.data.relational.repository.Lock
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Spring Data R2DBC repository (coroutines), derived queries only - no SQL in the code. Changes go through `save()`,
 * which checks and raises `@Version` itself. Only [BoardRepositoryAdapter] uses it.
 */
internal interface BoardR2dbcRepository : CoroutineCrudRepository<BoardEntity, Uuid> {

    fun findAllByOwnerIdAndFolderIdIsNullAndDeletedAtIsNull(ownerId: Uuid, pageable: Pageable): Flow<BoardEntity>

    suspend fun countByOwnerIdAndFolderIdIsNullAndDeletedAtIsNull(ownerId: Uuid): Long

    fun findAllByFolderIdAndDeletedAtIsNull(folderId: Uuid, pageable: Pageable): Flow<BoardEntity>

    suspend fun countByFolderIdAndDeletedAtIsNull(folderId: Uuid): Long

    fun findAllByFolderIdIn(folderIds: Collection<Uuid>): Flow<BoardEntity>

    fun findAllByOwnerIdAndDeletedAtIsNotNull(ownerId: Uuid): Flow<BoardEntity>

    fun findAllByDeletedAtBefore(before: Instant): Flow<BoardEntity>

    suspend fun countByDeletedAtIsNull(): Long

    /** `SELECT … FOR UPDATE`: the row stays locked until the transaction ends. */
    @Lock(LockMode.PESSIMISTIC_WRITE)
    suspend fun findForUpdateById(id: Uuid): BoardEntity?
}
