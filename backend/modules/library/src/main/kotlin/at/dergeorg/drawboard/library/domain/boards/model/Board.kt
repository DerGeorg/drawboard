package at.dergeorg.drawboard.library.domain.boards.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The metadata of a board (the drawing itself lives elsewhere). Immutable; changes produce a copy. [ownerId] is the
 * id of a user of the `users` module - this module only stores it. [version] is the optimistic lock: every change
 * raises it, and an update based on an older version is rejected (`CONFLICT`).
 */
data class Board(
    val id: Uuid,
    val title: String,
    val ownerId: Uuid,
    val createdAt: Instant,
    val updatedAt: Instant,
    val version: Long = 0,
    /** The folder the board lives in; null = the root of the owner's space. */
    val folderId: Uuid? = null,
    /** Set while the board is in the trash (30 days, then purged). */
    val deletedAt: Instant? = null,
) {
    companion object {
        const val MAX_TITLE_LENGTH = 200
    }
}
