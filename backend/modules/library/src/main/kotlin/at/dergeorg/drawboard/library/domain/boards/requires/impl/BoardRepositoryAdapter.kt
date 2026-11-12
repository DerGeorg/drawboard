package at.dergeorg.drawboard.library.domain.boards.requires.impl

import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.data.relational.core.query.Update
import org.springframework.stereotype.Repository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the domain's [BoardRepository] port with Spring Data R2DBC. */
@Repository
internal class BoardRepositoryAdapter(
    private val boards: BoardR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : BoardRepository {

    @WithSpan
    override suspend fun findById(id: Uuid): Board? = boards.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findForUpdate(id: Uuid): Board? = boards.findForUpdateById(id)?.toDomain()

    @WithSpan
    override suspend fun findPageInRoot(ownerId: Uuid, query: PageQuery): Page<Board> {
        val pageable = PageRequest.of(query.number, query.size, NEWEST_CHANGE_FIRST)
        val items = boards.findAllByOwnerIdAndFolderIdIsNullAndDeletedAtIsNull(ownerId, pageable).map { it.toDomain() }.toList()
        return Page(items, query, totalElements = boards.countByOwnerIdAndFolderIdIsNullAndDeletedAtIsNull(ownerId))
    }

    @WithSpan
    override suspend fun findPageInFolder(folderId: Uuid, query: PageQuery): Page<Board> {
        val pageable = PageRequest.of(query.number, query.size, NEWEST_CHANGE_FIRST)
        val items = boards.findAllByFolderIdAndDeletedAtIsNull(folderId, pageable).map { it.toDomain() }.toList()
        return Page(items, query, totalElements = boards.countByFolderIdAndDeletedAtIsNull(folderId))
    }

    @WithSpan
    override suspend fun findAllInFolders(folderIds: Collection<Uuid>): List<Board> =
        if (folderIds.isEmpty()) emptyList() else boards.findAllByFolderIdIn(folderIds).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<Board> =
        if (ids.isEmpty()) emptyList() else boards.findAllById(ids).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findDeletedByOwner(ownerId: Uuid): List<Board> =
        boards.findAllByOwnerIdAndDeletedAtIsNotNull(ownerId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findDeletedBefore(before: Instant): List<Board> =
        boards.findAllByDeletedAtBefore(before).map { it.toDomain() }.toList()

    /** A null version makes `save()` INSERT - the id is already set, Spring Data cannot tell "new" from it. */
    @WithSpan
    override suspend fun insert(board: Board): Board = boards.save(board.toEntity(version = null)).toDomain()

    /** `save()` with the version the change is based on: `UPDATE … WHERE id = ? AND version = ?`, version + 1. */
    @WithSpan
    override suspend fun update(board: Board): Board? = try {
        boards.save(board.toEntity(version = board.version)).toDomain()
    } catch (_: OptimisticLockingFailureException) {
        null
    }

    /** A targeted update, deliberately not `save()`: the cascade must not collide with concurrent renames. */
    @WithSpan
    override suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?) {
        if (ids.isEmpty()) return
        template.update(BoardEntity::class.java)
            .matching(Query.query(Criteria.where("id").`in`(ids)))
            .apply(Update.update("deletedAt", at))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) boards.deleteAllById(ids)
    }

    @WithSpan
    override suspend fun count(): Long = boards.countByDeletedAtIsNull()

    /**
     * A targeted update of one column, deliberately NOT `save()`: it must not touch `version` (the optimistic lock of
     * the metadata) - typing in the drawing is not a concurrent change of the title.
     */
    @WithSpan
    override suspend fun touch(id: Uuid, at: Instant) {
        template.update(BoardEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(id).and("updatedAt").lessThan(at)))
            .apply(Update.update("updatedAt", at))
            .awaitSingle()
    }

    private companion object {
        // The id (UUIDv7) keeps boards changed in the same instant in a stable order.
        val NEWEST_CHANGE_FIRST: Sort = Sort.by("updatedAt", "id").descending()
    }
}
