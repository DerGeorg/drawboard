package at.dergeorg.drawboard.collab.domain.storage.requires.impl

import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `collab.board_update`. Only used inside requires/impl; the domain sees [LoggedUpdate]. */
@Table(schema = "collab", name = "board_update")
internal data class UpdateEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val seq: Long,
    val data: ByteArray,
    val size: Int,
    val authorId: Uuid,
    val createdAt: Instant,
)

internal fun UpdateEntity.toDomain() = LoggedUpdate(
    boardId = boardId,
    seq = seq,
    data = data,
    authorId = authorId,
    createdAt = createdAt,
)

internal fun LoggedUpdate.toEntity() = UpdateEntity(
    id = Uuid.generateV7(),
    boardId = boardId,
    seq = seq,
    data = data,
    size = data.size,
    authorId = authorId,
    createdAt = createdAt,
)

/**
 * The same table WITHOUT the bytes: for "what is the highest seq", a query that must not load a megabyte. Read only.
 */
@Table(schema = "collab", name = "board_update")
internal data class UpdateRowEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val seq: Long,
    val size: Int,
)
