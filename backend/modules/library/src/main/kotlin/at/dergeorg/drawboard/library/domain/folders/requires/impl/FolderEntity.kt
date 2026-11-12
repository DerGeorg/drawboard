package at.dergeorg.drawboard.library.domain.folders.requires.impl

import at.dergeorg.drawboard.library.domain.folders.model.Folder
import org.springframework.data.annotation.Id
import org.springframework.data.annotation.Version
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `library.folder`. Only used inside requires/impl; the domain sees [Folder]. */
@Table(schema = "library", name = "folder")
internal data class FolderEntity(
    @Id val id: Uuid,
    val name: String,
    val ownerId: Uuid,
    val parentId: Uuid?,
    val createdAt: Instant,
    val updatedAt: Instant,
    val deletedAt: Instant?,
    /** Optimistic lock; `null` marks a new entity (the id is assigned by the application, see BoardEntity). */
    @Version val version: Long? = null,
)

internal fun FolderEntity.toDomain() = Folder(
    id = id,
    name = name,
    ownerId = ownerId,
    parentId = parentId,
    createdAt = createdAt,
    updatedAt = updatedAt,
    version = checkNotNull(version) { "folder $id has no version" },
    deletedAt = deletedAt,
)

internal fun Folder.toEntity(version: Long?) = FolderEntity(
    id = id,
    name = name,
    ownerId = ownerId,
    parentId = parentId,
    createdAt = createdAt,
    updatedAt = updatedAt,
    deletedAt = deletedAt,
    version = version,
)
