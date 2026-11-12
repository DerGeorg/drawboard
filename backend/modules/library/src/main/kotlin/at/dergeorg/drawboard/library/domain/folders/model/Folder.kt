package at.dergeorg.drawboard.library.domain.folders.model

import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * A folder of a user's personal space. Folders form a tree ([parentId] null = the root of the space). [deletedAt] is set
 * while the folder is in the trash: the folder and everything below it carry the same instant, which is how a restore
 * finds what was deleted together with it. [version] is the optimistic lock.
 */
data class Folder(
    val id: Uuid,
    val name: String,
    val ownerId: Uuid,
    val parentId: Uuid?,
    val createdAt: Instant,
    val updatedAt: Instant,
    val version: Long = 0,
    val deletedAt: Instant? = null,
) {
    companion object {
        const val MAX_NAME_LENGTH = 200
    }
}

/** A folder together with the role the asking caller has on it. */
data class FolderView(val folder: Folder, val role: BoardRole)
