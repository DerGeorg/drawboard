package at.dergeorg.drawboard.api.domain.library.boards.provides.impl

import at.dergeorg.drawboard.api.domain.library.boards.provides.BoardsApiUseCase
import at.dergeorg.drawboard.contract.api.BoardsApi
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardMove
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.Trash
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [BoardsApi] (paths, parameters, validation come from the contract), sets
 * status codes and headers, delegates everything else to [BoardsApiUseCase]. "Signed in" is checked by the route
 * table in core (SecurityConfig); what the user may do with a board is decided by the library module.
 *
 * Lives in provides/impl: the generated [BoardsApi] is what the api module provides for the boards subdomain, this
 * class is its implementation (next to [BoardsApiUseCase], which it delegates to).
 */
@RestController
internal class BoardsController(
    private val boards: BoardsApiUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
) : BoardsApi {

    @WithSpan
    override suspend fun listBoards(@SpanAttribute("folder.id") folderId: Uuid?, page: Int, size: Int): ResponseEntity<BoardPage> =
        ResponseEntity.ok(boards.listBoards(folderId, page, size))

    @WithSpan
    override suspend fun getBoard(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<Board> =
        ResponseEntity.ok(boards.getBoard(boardId))

    @WithSpan
    override suspend fun createBoard(newBoard: NewBoard): ResponseEntity<Board> {
        val created = boards.createBoard(newBoard)
        val location = UriComponentsBuilder.fromPath(basePath).path(BoardsApi.PATH_GET_BOARD).buildAndExpand(created.id).toUri()
        return ResponseEntity.created(location).body(created)
    }

    @WithSpan
    override suspend fun updateBoard(@SpanAttribute("board.id") boardId: Uuid, boardUpdate: BoardUpdate): ResponseEntity<Board> =
        ResponseEntity.ok(boards.updateBoard(boardId, boardUpdate))

    @WithSpan
    override suspend fun deleteBoard(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<Unit> {
        boards.deleteBoard(boardId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun moveBoard(@SpanAttribute("board.id") boardId: Uuid, boardMove: BoardMove): ResponseEntity<Board> =
        ResponseEntity.ok(boards.moveBoard(boardId, boardMove))

    @WithSpan
    override suspend fun listTrash(): ResponseEntity<Trash> = ResponseEntity.ok(boards.listTrash())

    @WithSpan
    override suspend fun restoreBoard(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<Board> =
        ResponseEntity.ok(boards.restoreBoard(boardId))

    @WithSpan
    override suspend fun purgeBoard(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<Unit> {
        boards.purgeBoard(boardId)
        return ResponseEntity.noContent().build()
    }
}
