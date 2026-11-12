package at.dergeorg.drawboard.collab.domain.rooms.model

/** What a user may do in an open board. Same names as `BoardRole` of the API contract; collab does not know library. */
enum class CollabRole {
    OWNER,
    EDITOR,
    COMMENTER,
    VIEWER,
    ;

    /** May send `UPDATE` frames (S2.4). */
    val canEdit: Boolean get() = this == OWNER || this == EDITOR
}
