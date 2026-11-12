package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.stereotype.Repository
import kotlin.uuid.Uuid

/** Implements the domain's [FileRepository] port with Spring Data R2DBC. */
@Repository
internal class FileRepositoryAdapter(private val files: FileR2dbcRepository) : FileRepository {

    @WithSpan
    override suspend fun findById(id: Uuid): StoredFile? = files.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findByBoard(boardId: Uuid): List<StoredFile> =
        files.findAllByBoardIdOrderByCreatedAtDescIdDesc(boardId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findByBoards(boardIds: Collection<Uuid>): List<StoredFile> =
        if (boardIds.isEmpty()) emptyList() else files.findAllByBoardIdIn(boardIds).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findByConversion(state: Conversion): List<StoredFile> =
        files.findAllByConversion(state.name).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun countByBoard(boardId: Uuid): Long = files.countByBoardId(boardId)

    @WithSpan
    override suspend fun usedBytesOfBoard(boardId: Uuid): Long = files.sumSizeOfBoard(boardId)

    @WithSpan
    override suspend fun usedBytesOfUser(userId: Uuid): Long = files.sumSizeOfUser(userId)

    @WithSpan
    override suspend fun totalBytes(): Long = files.sumSizeOfAll()

    /** A null version makes `save()` INSERT - the id is already set, Spring Data cannot tell "new" from it. */
    @WithSpan
    override suspend fun insert(file: StoredFile): StoredFile = files.save(file.toEntity(version = null)).toDomain()

    @WithSpan
    override suspend fun update(file: StoredFile): StoredFile? = try {
        files.save(file.toEntity(version = file.version)).toDomain()
    } catch (_: OptimisticLockingFailureException) {
        null
    }

    @WithSpan
    override suspend fun existing(ids: Collection<Uuid>): Set<Uuid> =
        if (ids.isEmpty()) emptySet() else files.findAllById(ids).map { it.id }.toList().toSet()

    @WithSpan
    override suspend fun deleteByIds(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) files.deleteAllById(ids)
    }
}
