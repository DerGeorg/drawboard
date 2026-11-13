package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.LibraryErrors
import at.dergeorg.drawboard.library.common.LibraryProperties
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import at.dergeorg.drawboard.library.domain.boards.requires.TemplateMetrics
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import kotlin.time.Duration.Companion.minutes
import at.dergeorg.drawboard.library.domain.boards.BoardAccess
import at.dergeorg.drawboard.library.domain.boards.model.BoardMoved
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.model.BoardCreated
import at.dergeorg.drawboard.library.domain.boards.model.BoardDeleted
import at.dergeorg.drawboard.library.domain.boards.model.BoardRenamed
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardTemplateChanged
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.MoveBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.UpdateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements every use case of the library module. The transaction boundary: each change and its audit event are
 * written in one transaction - both or neither.
 */
@Service
internal class LibraryService(
    private val boards: BoardRepository,
    private val folders: FolderRepository,
    private val grants: GrantRepository,
    private val access: AccessResolver,
    private val audit: AuditTrail,
    private val clock: Clock,
    private val metrics: TemplateMetrics,
    properties: LibraryProperties,
) : BoardsUseCase {

    private val events = DomainEvents(LibraryModule.NAME)

    /** listTemplates per user: every call resolves the access of up to [MAX_TEMPLATE_CANDIDATES] boards. */
    private val templateLists = WindowRateLimiter(clock, RateRule(properties.templateListsPerMinute, 1.minutes))

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listBoards(caller: Caller, @SpanAttribute("folder.id") folderId: Uuid?, page: PageQuery): Page<BoardView> {
        if (folderId == null) {
            // The root of the own space; guests have no space (S1.8).
            val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
            val result = boards.findPageInRoot(user.id, page)
            return Page(result.items.map { BoardView(it, BoardRole.OWNER) }, page, result.totalElements)
        }
        val folder = folders.findById(folderId) ?: throw LibraryErrors.folderNotFound(folderId)
        val folderRole = access.folderRole(folder, caller) ?: throw LibraryErrors.folderNotFound(folderId)
        val result = boards.findPageInFolder(folderId, page)
        return Page(result.items.map { BoardView(it, access.boardRole(it, caller) ?: folderRole) }, page, result.totalElements)
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listTemplates(caller: Caller, page: PageQuery): Page<BoardView> {
        if (caller !is Caller.User) throw DomainException(ErrorCode.FORBIDDEN)
        takeTemplateList(caller)
        // Candidates come from the caller's own rights, never from "all templates"; the role per candidate is the
        // final check, the page is cut in memory (see the use case).
        val ancestors = HashMap<Uuid?, List<Uuid>>() // per call: boards in the same folder share one walk up the tree
        val visible = templateCandidates(caller)
            .mapNotNull { board -> access.boardRole(board, caller, ancestors)?.let { BoardView(board, it) } }
            .sortedWith(compareByDescending<BoardView> { it.board.updatedAt }.thenByDescending { it.board.id })
        // page * size can exceed Int.MAX_VALUE (a huge page number): cap the offset at the end of the list first.
        val from = page.offset.coerceAtMost(visible.size.toLong()).toInt()
        return Page(visible.drop(from).take(page.size), page, visible.size.toLong())
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun getBoard(caller: Caller, @SpanAttribute("board.id") boardId: Uuid): BoardView {
        val board = findExisting(boardId)
        return BoardView(board, visibleRole(board, caller))
    }

    @WithSpan
    @Transactional
    override suspend fun createBoard(command: CreateBoardCommand): BoardView {
        val title = LibraryErrors.validText("title", command.title, Board.MAX_TITLE_LENGTH)
        command.folderId?.let { ownFolder(it, command.ownerId) }
        val now = clock.now()
        val board = boards.insert(
            Board(
                id = Uuid.generateV7(),
                title = title,
                ownerId = command.ownerId,
                createdAt = now,
                updatedAt = now,
                folderId = command.folderId,
                template = command.template,
            ),
        )
        audit.record(events.created(BOARD, board.id, after = board, details = BoardCreated(submittedTitle = command.title)))
        return BoardView(board, BoardRole.OWNER)
    }

    @WithSpan
    @Transactional
    override suspend fun updateBoard(command: UpdateBoardCommand): BoardView {
        val title = LibraryErrors.validText("title", command.title, Board.MAX_TITLE_LENGTH)
        val board = findExisting(command.boardId)
        val role = visibleRole(board, command.caller)
        BoardAccess.require(board.id, role, BoardAccess.CAN_EDIT)
        val template = command.template ?: board.template
        // Only the owner decides what is a template; an editor may send the current value back (a rename form does).
        if (template != board.template) BoardAccess.require(board.id, role, BoardAccess.CAN_CHANGE_TEMPLATE)
        if (board.version != command.version) throw conflict(board)
        val renamed = board.title != title
        val templateChanged = template != board.template
        if (!renamed && !templateChanged) return BoardView(board, role)

        // Changed (or deleted) by a concurrent request between the read and this write: tell which one.
        val updated = boards.update(board.copy(title = title, template = template, updatedAt = clock.now()))
            ?: throw conflict(findExisting(board.id))
        if (renamed) {
            val details = BoardRenamed(submittedTitle = command.title, basedOnVersion = command.version)
            audit.record(events.updated(BOARD, board.id, before = board, after = updated, details = details))
        }
        if (templateChanged) {
            val details = BoardTemplateChanged(template = template, basedOnVersion = command.version)
            audit.record(events.updated(BOARD, board.id, before = board, after = updated, details = details))
        }
        return BoardView(updated, role)
    }

    @WithSpan
    @Transactional
    override suspend fun moveBoard(command: MoveBoardCommand): BoardView {
        val board = boards.findForUpdate(command.boardId)?.takeIf { it.deletedAt == null }
            ?: throw LibraryErrors.boardNotFound(command.boardId)
        val role = visibleRole(board, command.caller)
        BoardAccess.require(board.id, role, BoardAccess.CAN_DELETE)
        if (board.version != command.version) throw conflict(board)
        command.folderId?.let { ownFolder(it, board.ownerId) }
        if (board.folderId == command.folderId) return BoardView(board, role)

        val moved = board.copy(folderId = command.folderId, updatedAt = clock.now())
        val updated = boards.update(moved) ?: throw conflict(findExisting(board.id))
        val details = BoardMoved(folderId = command.folderId?.toString(), basedOnVersion = command.version)
        audit.record(events.updated(BOARD, board.id, before = board, after = updated, details = details))
        return BoardView(updated, role)
    }

    @WithSpan
    @Transactional
    override suspend fun deleteBoard(caller: Caller, @SpanAttribute("board.id") boardId: Uuid) {
        // Locked until the transaction ends: a concurrent deletion or rename waits here and then finds the new state.
        val board = boards.findForUpdate(boardId)?.takeIf { it.deletedAt == null } ?: throw LibraryErrors.boardNotFound(boardId)
        BoardAccess.require(board.id, visibleRole(board, caller), BoardAccess.CAN_DELETE)
        val now = clock.now()
        boards.update(board.copy(deletedAt = now, updatedAt = now)) ?: throw conflict(findExisting(boardId))

        audit.record(events.deleted(BOARD, boardId, before = board, details = BoardDeleted(age = now - board.createdAt)))
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun roleOf(caller: Caller, @SpanAttribute("board.id") boardId: Uuid): BoardRole? =
        boards.findById(boardId)?.let { access.boardRole(it, caller) }

    @WithSpan
    @Transactional
    override suspend fun recordContentChange(@SpanAttribute("board.id") boardId: Uuid, at: Instant) = boards.touch(boardId, at)

    /** Counts the call; over the limit it is refused (429) and only the metric records it - no audit event. */
    private fun takeTemplateList(caller: Caller.User) {
        try {
            templateLists.take(caller.id.toString())
        } catch (e: RateLimitedException) {
            metrics.listRefused()
            throw e
        }
    }

    /**
     * Three queries plus one per folder level: the grants of the caller (user and link grants, groups of the CURRENT
     * token - like "shared with me"), the folders below the folders they hold a grant on (level by level, at most
     * [AccessResolver.MAX_DEPTH] levels) and ONE bounded statement for the templates among own boards, granted boards
     * and boards in those folders.
     */
    private suspend fun templateCandidates(caller: Caller.User): List<Board> {
        val mine = grants.findForPrincipal(caller.id, caller.groups)
        // Newest grants first, at most MAX_TEMPLATE_FOLDERS of each kind: no statement binds more than ~2000 parameters.
        val newestFirst = mine.sortedByDescending { it.updatedAt }
        val boardIds = newestFirst.filter { it.resourceKind == ResourceKind.BOARD }.map { it.resourceId }
            .distinct().take(MAX_TEMPLATE_FOLDERS).toSet()
        val roots = newestFirst.filter { it.resourceKind == ResourceKind.FOLDER }.map { it.resourceId }
            .distinct().take(MAX_TEMPLATE_FOLDERS).toSet()
        val folderIds = subtreeOf(roots)
        return boards.findTemplateCandidates(caller.id, boardIds, folderIds, MAX_TEMPLATE_CANDIDATES)
    }

    /**
     * [roots] and the folders below them (trash included: the access check drops what is in the trash), level by
     * level, at most [MAX_TEMPLATE_FOLDERS] folders in all: the search stops when that many are collected, and a level
     * is cut (newest first) to the budget that is left. So a very wide or deep tree cannot blow up the statements.
     */
    private suspend fun subtreeOf(roots: Set<Uuid>): Set<Uuid> {
        val all = LinkedHashSet(roots)
        var level: Set<Uuid> = roots
        var depth = 0
        while (level.isNotEmpty() && all.size < MAX_TEMPLATE_FOLDERS && depth++ < AccessResolver.MAX_DEPTH) {
            level = folders.findChildren(level)
                .filter { it.id !in all }
                .sortedByDescending { it.updatedAt }
                .take(MAX_TEMPLATE_FOLDERS - all.size)
                .map { it.id }.toSet()
            all += level
        }
        return all
    }

    private suspend fun findExisting(id: Uuid): Board =
        boards.findById(id)?.takeIf { it.deletedAt == null } ?: throw LibraryErrors.boardNotFound(id)

    /** The caller's role, or "not found": a caller without a role must not learn that the board exists. */
    private suspend fun visibleRole(board: Board, caller: Caller): BoardRole =
        access.boardRole(board, caller) ?: throw LibraryErrors.boardNotFound(board.id)

    /** A folder of [ownerId] that is not in the trash, else `LIBRARY_FOLDER_NOT_FOUND`. */
    private suspend fun ownFolder(folderId: Uuid, ownerId: Uuid) =
        folders.findById(folderId)?.takeIf { it.ownerId == ownerId && it.deletedAt == null } ?: throw LibraryErrors.folderNotFound(folderId)

    /** Optimistic lock: the caller based its change on an older version than [current]. */
    private fun conflict(current: Board) = LibraryErrors.conflict("board", current.id, current.version)

    private companion object {
        const val BOARD = "board"
        const val MAX_TEMPLATE_CANDIDATES = 1000
        const val MAX_TEMPLATE_FOLDERS = 1000
    }
}
