package at.dergeorg.drawboard.collab.domain.rooms.requires

import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import kotlin.uuid.Uuid

/**
 * Port: the role of a participant on a board, asked at the handshake and every minute while the session is open. Implemented
 * in module api on top of library - collab and library never know each other.
 */
interface BoardAccess {

    /** The participant's role now, or null if they have none (or the board does not exist). */
    suspend fun roleOf(boardId: Uuid, who: Participant): CollabRole?
}
