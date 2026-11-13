package at.dergeorg.drawboard.library.domain.folders.requires.impl

import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.data.relational.core.query.Update
import org.springframework.stereotype.Repository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the domain's [FolderRepository] port with Spring Data R2DBC. */
@Repository
internal class FolderRepositoryAdapter(
    private val folders: FolderR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : FolderRepository {

    @WithSpan
    override suspend fun findById(id: Uuid): Folder? = folders.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findAllByOwner(ownerId: Uuid): List<Folder> = folders.findAllByOwnerId(ownerId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findChildren(parentIds: Collection<Uuid>): List<Folder> =
        if (parentIds.isEmpty()) emptyList() else folders.findAllByParentIdIn(parentIds).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<Folder> =
        if (ids.isEmpty()) emptyList() else folders.findAllById(ids).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findDeletedBefore(before: Instant): List<Folder> =
        folders.findAllByDeletedAtBefore(before).map { it.toDomain() }.toList()

    /** A null version makes `save()` INSERT. */
    @WithSpan
    override suspend fun insert(folder: Folder): Folder = folders.save(folder.toEntity(version = null)).toDomain()

    @WithSpan
    override suspend fun update(folder: Folder): Folder? = try {
        folders.save(folder.toEntity(version = folder.version)).toDomain()
    } catch (_: OptimisticLockingFailureException) {
        null
    }

    /** A targeted update, deliberately not `save()`: the cascade must not collide with concurrent renames. */
    @WithSpan
    override suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?) {
        if (ids.isEmpty()) return
        template.update(FolderEntity::class.java)
            .matching(Query.query(Criteria.where("id").`in`(ids)))
            .apply(Update.update("deletedAt", at))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) folders.deleteAllById(ids)
    }
}
