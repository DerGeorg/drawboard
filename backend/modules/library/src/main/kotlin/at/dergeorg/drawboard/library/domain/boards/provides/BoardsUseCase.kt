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

    /**
     * The template boards the caller may open (users only, guests get `FORBIDDEN`): their own in any folder and every
     * template they have at least `VIEWER` on - granted directly, through a group of the current token, through a share
     * link they opened, or inherited from a shared folder. The role in each view is the effective one. Trash excluded
     * (the board itself or via its folder). Most recently changed first, then by id.
     *
     * Candidates are never "all templates" but what the caller's own rights can reach: their own boards, boards with a
     * grant for them (user, group of the current token, link) and boards in or below folders with such a grant - one
     * SQL statement, newest first, at most 1000 rows. The final role of each candidate comes from the `AccessResolver`
     * (the one place for access rules); the page is cut in memory. A caller who can reach more than 1000 templates
     * sees the 1000 most recently changed ones. Likewise at most 1000 granted boards (newest grant first) and 1000
     * folders (granted ones first, then their subfolders level by level) are searched: whoever reaches more
     * folders or boards through shares sees the templates of the first ones only. At most 30 calls per minute and user (`LIBRARY_TEMPLATE_LISTS_PER_MINUTE`):
     * more is `TOO_MANY_REQUESTS` (429, `Retry-After`), counted by a metric and not audited.
     */
    suspend fun listTemplates(caller: Caller, page: PageQuery): Page<BoardView>

    suspend fun getBoard(caller: Caller, boardId: Uuid): BoardView

    /**
     * The creator becomes the owner; [CreateBoardCommand.folderId] must be one of their own folders;
     * [CreateBoardCommand.template] creates the board as a template.
     */
    suspend fun createBoard(command: CreateBoardCommand): BoardView

    /**
     * Changes the title and/or the template flag; needs the role `EDITOR` or `OWNER`. Changing the template flag
     * needs `OWNER`: an editor who sends another value than the current one gets `LIBRARY_BOARD_ACCESS_DENIED`
     * (required: OWNER, like every other role failure); the same value is fine. Fails with `CONFLICT` if [UpdateBoardCommand.version] is not the current version (the board was changed
     * in between). Nothing that stays the same is changed or audited.
     */
    suspend fun updateBoard(command: UpdateBoardCommand): BoardView

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
data class CreateBoardCommand(val ownerId: Uuid, val title: String, val folderId: Uuid? = null, val template: Boolean = false)

/**
 * Input of [BoardsUseCase.updateBoard]: the new [title] (trimmed like on create), the new [template] flag (null =
 * unchanged) and the [version] it is based on.
 */
data class UpdateBoardCommand(
    val caller: Caller,
    val boardId: Uuid,
    val title: String,
    val version: Long,
    val template: Boolean? = null,
)

/** Input of [BoardsUseCase.moveBoard]: the target [folderId] (null = root) and the [version] it is based on. */
data class MoveBoardCommand(val caller: Caller, val boardId: Uuid, val folderId: Uuid?, val version: Long)
