package at.dergeorg.drawboard.collab.domain.rooms.requires

import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Port: "the drawing of this board changed" - library shows it as the board's `updatedAt`. Called at most once per
 * minute and board (collab throttles); implemented in module api.
 */
interface BoardActivity {
    suspend fun contentChanged(boardId: Uuid, at: Instant)
}
