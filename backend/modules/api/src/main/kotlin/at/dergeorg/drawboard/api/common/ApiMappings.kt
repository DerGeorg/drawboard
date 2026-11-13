package at.dergeorg.drawboard.api.common

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.PageInfo
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole as LibraryBoardRole

// Mappings between shared domain types and contract types that every part of the api module needs. Ids and
// timestamps need none: the contract uses kotlin.uuid.Uuid and kotlin.time.Instant like the domain.

internal fun Page<*>.toPageInfo() = PageInfo(
    number = query.number,
    size = query.size,
    totalElements = totalElements,
    totalPages = totalPages,
)

internal fun BoardView.toApi() = Board(
    id = board.id,
    title = board.title,
    ownerId = board.ownerId,
    folderId = board.folderId,
    role = role.toApi(),
    template = board.template,
    createdAt = board.createdAt,
    updatedAt = board.updatedAt,
    version = board.version,
    deletedAt = board.deletedAt,
)

internal fun FolderView.toApi() = Folder(
    id = folder.id,
    name = folder.name,
    ownerId = folder.ownerId,
    parentId = folder.parentId,
    role = role.toApi(),
    createdAt = folder.createdAt,
    updatedAt = folder.updatedAt,
    version = folder.version,
    deletedAt = folder.deletedAt,
)

internal fun LibraryBoardRole.toApi() = when (this) {
    LibraryBoardRole.OWNER -> BoardRole.OWNER
    LibraryBoardRole.EDITOR -> BoardRole.EDITOR
    LibraryBoardRole.COMMENTER -> BoardRole.COMMENTER
    LibraryBoardRole.VIEWER -> BoardRole.VIEWER
}
