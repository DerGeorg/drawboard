package at.dergeorg.drawboard.library.domain.boards

import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BoardAccessTest {

    @Nested
    inner class Require {

        @Test
        fun `when requiring editing given EDITOR and OWNER then it passes`() {
            BoardAccess.require(BOARD, BoardRole.EDITOR, BoardAccess.CAN_EDIT)
            BoardAccess.require(BOARD, BoardRole.OWNER, BoardAccess.CAN_EDIT)
        }

        @Test
        fun `when requiring editing given a weaker role then LIBRARY_BOARD_ACCESS_DENIED names the required roles`() {
            listOf(BoardRole.COMMENTER, BoardRole.VIEWER).forEach { role ->
                val failure = assertFailsWith<DomainException>("$role may not edit") {
                    BoardAccess.require(BOARD, role, BoardAccess.CAN_EDIT)
                }

                assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, failure.errorCode, "error code for $role")
                assertEquals(
                    mapOf("boardId" to BOARD.toString(), "required" to "OWNER or EDITOR"),
                    failure.params,
                    "params for $role",
                )
            }
        }

        @Test
        fun `when requiring delete given anything but OWNER then LIBRARY_BOARD_ACCESS_DENIED`() {
            listOf(BoardRole.EDITOR, BoardRole.COMMENTER, BoardRole.VIEWER).forEach { role ->
                val failure = assertFailsWith<DomainException>("$role may not delete") {
                    BoardAccess.require(BOARD, role, BoardAccess.CAN_DELETE)
                }

                assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, failure.errorCode, "error code for $role")
            }
            BoardAccess.require(BOARD, BoardRole.OWNER, BoardAccess.CAN_DELETE)
        }
    }
}
