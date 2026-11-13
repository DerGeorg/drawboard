package at.dergeorg.drawboard.library.domain.folders.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Spring Data R2DBC repository of folders, derived queries only. Only [FolderRepositoryAdapter] uses it. */
internal interface FolderR2dbcRepository : CoroutineCrudRepository<FolderEntity, Uuid> {

    fun findAllByOwnerId(ownerId: Uuid): Flow<FolderEntity>

    fun findAllByParentIdIn(parentIds: Collection<Uuid>): Flow<FolderEntity>

    fun findAllByDeletedAtBefore(before: Instant): Flow<FolderEntity>
}
