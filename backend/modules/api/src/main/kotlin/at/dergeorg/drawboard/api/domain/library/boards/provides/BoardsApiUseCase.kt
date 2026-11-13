package at.dergeorg.drawboard.api.domain.library.boards.provides

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardMove
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.Trash
import kotlin.uuid.Uuid

/** The boards part of the API in contract types. The controller does HTTP, this does the translation to the library. */
interface BoardsApiUseCase {

    suspend fun listBoards(folderId: Uuid?, page: Int, size: Int): BoardPage

    suspend fun listTemplates(page: Int, size: Int): BoardPage

    suspend fun getBoard(boardId: Uuid): Board

    suspend fun createBoard(newBoard: NewBoard): Board

    suspend fun updateBoard(boardId: Uuid, boardUpdate: BoardUpdate): Board

    suspend fun moveBoard(boardId: Uuid, boardMove: BoardMove): Board

    suspend fun deleteBoard(boardId: Uuid)

    suspend fun listTrash(): Trash

    suspend fun restoreBoard(boardId: Uuid): Board

    suspend fun purgeBoard(boardId: Uuid)
}
