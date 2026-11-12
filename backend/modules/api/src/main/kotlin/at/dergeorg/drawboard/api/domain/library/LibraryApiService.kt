package at.dergeorg.drawboard.api.domain.library

import at.dergeorg.drawboard.api.common.BoardDataEraser
import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.common.toApi
import at.dergeorg.drawboard.api.common.toPageInfo
import at.dergeorg.drawboard.api.domain.library.boards.provides.BoardsApiUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardMove
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.Trash
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.domain.boards.provides.CreateBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.MoveBoardCommand
import at.dergeorg.drawboard.library.domain.boards.provides.RenameBoardCommand
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import at.dergeorg.drawboard.shared.paging.PageQuery
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the API use cases that belong to the library module: contract types in, library use cases, contract
 * types out. The library never learns who the caller is by token or user module - this service looks the caller up
 * through the users module ([SignedInUsers]) and hands the library the user's own id and current groups. Where a
 * change must reach the collaboration (sessions to close, data to delete), this service tells collab AFTER the
 * library committed - the two modules never know each other.
 */
@Service
internal class LibraryApiService(
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val trash: TrashUseCase,
    private val collab: CollabUseCase,
    private val eraser: BoardDataEraser,
) : BoardsApiUseCase {

    @WithSpan
    override suspend fun listBoards(@SpanAttribute("folder.id") folderId: Uuid?, page: Int, size: Int): BoardPage {
        val result = boards.listBoards(callers.any(), folderId, PageQuery(number = page, size = size))
        return BoardPage(items = result.items.map { it.toApi() }, page = result.toPageInfo())
    }

    @WithSpan
    override suspend fun getBoard(@SpanAttribute("board.id") boardId: Uuid): Board = boards.getBoard(callers.any(), boardId).toApi()

    @WithSpan
    override suspend fun createBoard(newBoard: NewBoard): Board =
        boards.createBoard(CreateBoardCommand(ownerId = signedIn.caller().id, title = newBoard.title, folderId = newBoard.folderId)).toApi()

    @WithSpan
    override suspend fun updateBoard(@SpanAttribute("board.id") boardId: Uuid, boardUpdate: BoardUpdate): Board {
        val command = RenameBoardCommand(
            caller = signedIn.caller(),
            boardId = boardId,
            title = boardUpdate.title,
            version = boardUpdate.version,
        )
        return boards.renameBoard(command).toApi()
    }

    @WithSpan
    override suspend fun moveBoard(@SpanAttribute("board.id") boardId: Uuid, boardMove: BoardMove): Board {
        val moved = boards.moveBoard(
            MoveBoardCommand(caller = signedIn.caller(), boardId = boardId, folderId = boardMove.folderId, version = boardMove.version),
        )
        // Grants inherited from the old folder stop applying, those of the new one start: sessions are re-evaluated.
        collab.recheckAll()
        return moved.toApi()
    }

    @WithSpan
    override suspend fun deleteBoard(@SpanAttribute("board.id") boardId: Uuid) {
        boards.deleteBoard(signedIn.caller(), boardId)
        // In the trash, restorable: the sessions end (4404), log and snapshots stay until the board is purged.
        collab.closeSessions(boardId)
    }

    @WithSpan
    override suspend fun listTrash(): Trash {
        val view = trash.listTrash(signedIn.caller())
        return Trash(
            boards = view.boards.map { BoardView(it, BoardRole.OWNER).toApi() },
            folders = view.folders.map { at.dergeorg.drawboard.library.domain.folders.model.FolderView(it, BoardRole.OWNER).toApi() },
        )
    }

    @WithSpan
    override suspend fun restoreBoard(@SpanAttribute("board.id") boardId: Uuid): Board =
        trash.restoreBoard(signedIn.caller(), boardId).toApi()

    @WithSpan
    override suspend fun purgeBoard(@SpanAttribute("board.id") boardId: Uuid) {
        eraser.erase(trash.purgeBoard(signedIn.caller(), boardId))
    }
}
