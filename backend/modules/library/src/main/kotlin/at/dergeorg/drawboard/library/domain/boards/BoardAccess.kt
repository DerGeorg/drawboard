package at.dergeorg.drawboard.library.domain.boards

import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import kotlin.uuid.Uuid

/** What each role may do with a board. The role itself comes from the `AccessResolver`. */
internal object BoardAccess {

    /** Roles that may change a board's metadata and drawing. */
    val CAN_EDIT: Set<BoardRole> = setOf(BoardRole.OWNER, BoardRole.EDITOR)

    /** Roles that may delete a board. */
    val CAN_DELETE: Set<BoardRole> = setOf(BoardRole.OWNER)

    /** [role] must be one of [allowed], otherwise `LIBRARY_BOARD_ACCESS_DENIED` (403). */
    fun require(boardId: Uuid, role: BoardRole, allowed: Set<BoardRole>) {
        if (role !in allowed) {
            throw DomainException(
                ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to boardId.toString(), "required" to allowed.sorted().joinToString(" or ")),
            )
        }
    }
}
