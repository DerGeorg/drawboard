package at.dergeorg.drawboard.library.domain.boards.provides

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * What the library offers other modules about boards. Every function takes the [Caller] and checks what that caller
 * may do. Every change is audited in the same transaction.
 *
 * A board the caller has no role on (also one in the trash) is reported as `LIBRARY_BOARD_NOT_FOUND` - never as
 * "forbidden" - so its existence is not revealed. A caller with a role that is too weak gets
 * `LIBRARY_BOARD_ACCESS_DENIED`.
 */
interface BoardsUseCase {

    /**
     * Without [folderId]: the boards in the root of the caller's own space (users only, else `FORBIDDEN`). With it:
     * the boards directly in that folder when the caller has at least `VIEWER` on it (else `LIBRARY_FOLDER_NOT_FOUND`).
     * Most recently changed first, trash excluded.
     */
    suspend fun listBoards(caller: Caller, folderId: Uuid?, page: PageQuery): Page<BoardView>

    suspend fun getBoard(caller: Caller, boardId: Uuid): BoardView

    /** The creator becomes the owner; [CreateBoardCommand.folderId] must be one of their own folders. */
    suspend fun createBoard(command: CreateBoardCommand): BoardView

    /**
     * Changes the title; needs the role `EDITOR` or `OWNER`. Fails with `CONFLICT` if
     * [RenameBoardCommand.version] is not the current version (the board was changed in between). An unchanged title
     * changes and audits nothing.
     */
    suspend fun renameBoard(command: RenameBoardCommand): BoardView

    /** Moves into another folder of the owner or into the root; needs `OWNER`; `CONFLICT` on an outdated version. */
    suspend fun moveBoard(command: MoveBoardCommand): BoardView

    /** To the trash (soft delete); needs the role `OWNER`. */
    suspend fun deleteBoard(caller: Caller, boardId: Uuid)

    /** The role [caller] has on the board, or null if there is none or the board does not exist. Never throws for that. */
    suspend fun roleOf(caller: Caller, boardId: Uuid): BoardRole?

    /**
     * The drawing of the board changed at [at] (reported by the collaboration): raises `updatedAt`, never lowers it.
     * The version does not change (a rename in progress must not conflict with typing in the drawing) and nothing is
     * audited - the content is not audited either.
     */
    suspend fun recordContentChange(boardId: Uuid, at: Instant)
}

/** Input of [BoardsUseCase.createBoard]. [title] as submitted: surrounding whitespace is removed, blank is rejected. */
data class CreateBoardCommand(val ownerId: Uuid, val title: String, val folderId: Uuid? = null)

/** Input of [BoardsUseCase.renameBoard]: the new [title] (trimmed like on create) and the [version] it is based on. */
data class RenameBoardCommand(val caller: Caller, val boardId: Uuid, val title: String, val version: Long)

/** Input of [BoardsUseCase.moveBoard]: the target [folderId] (null = root) and the [version] it is based on. */
data class MoveBoardCommand(val caller: Caller, val boardId: Uuid, val folderId: Uuid?, val version: Long)
