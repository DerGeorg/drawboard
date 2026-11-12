package at.dergeorg.drawboard.collab.domain.storage.requires.impl

import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `collab.board_snapshot`. Only used inside requires/impl; the domain sees [StoredSnapshot]. */
@Table(schema = "collab", name = "board_snapshot")
internal data class SnapshotEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val upToSeq: Long,
    val data: ByteArray,
    val size: Int,
    val createdBy: Uuid,
    val createdAt: Instant,
)

internal fun SnapshotEntity.toDomain() = StoredSnapshot(
    boardId = boardId,
    upToSeq = upToSeq,
    data = data,
    createdBy = createdBy,
    createdAt = createdAt,
)

internal fun StoredSnapshot.toEntity() = SnapshotEntity(
    id = Uuid.generateV7(),
    boardId = boardId,
    upToSeq = upToSeq,
    data = data,
    size = data.size,
    createdBy = createdBy,
    createdAt = createdAt,
)

/** The same table WITHOUT the bytes, so listing the snapshots for the retention never loads up to 50 MB each. Read only. */
@Table(schema = "collab", name = "board_snapshot")
internal data class SnapshotMetaEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val upToSeq: Long,
    val size: Int,
    val createdAt: Instant,
)

internal fun SnapshotMetaEntity.toDomain() = SnapshotMeta(id = id, upToSeq = upToSeq, size = size, createdAt = createdAt)
