package at.dergeorg.drawboard.library.domain.boards.model

/** What a user may do with a board, strongest first. Same names as `BoardRole` in the API contract. */
enum class BoardRole {
    /** Everything, including delete (and sharing, later). */
    OWNER,

    /** Change the drawing and the title. */
    EDITOR,

    /** Comment only. */
    COMMENTER,

    /** Read only. */
    VIEWER,
}

/** A board together with the role the asking user has on it - what every read use case returns. */
data class BoardView(val board: Board, val role: BoardRole)
