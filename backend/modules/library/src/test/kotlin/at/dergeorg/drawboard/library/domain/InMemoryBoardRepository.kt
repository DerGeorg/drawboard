package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fake of the internal [BoardRepository] port; [update] checks the version like the real adapter. */
internal class InMemoryBoardRepository(vararg initial: Board) : BoardRepository {
    private val boards = linkedMapOf<Uuid, Board>().apply { initial.forEach { put(it.id, it) } }

    /** Set to make the next [update] fail like a concurrent change would. */
    var failNextUpdate = false

    val all: List<Board> get() = boards.values.toList()

    override suspend fun findById(id: Uuid): Board? = boards[id]

    override suspend fun findForUpdate(id: Uuid): Board? = boards[id]

    private fun page(query: PageQuery, matching: (Board) -> Boolean): Page<Board> {
        val found = boards.values.filter(matching).sortedWith(compareByDescending<Board> { it.updatedAt }.thenByDescending { it.id })
        return Page(found.drop(query.offset.toInt()).take(query.size), query, totalElements = found.size.toLong())
    }

    override suspend fun findPageInRoot(ownerId: Uuid, query: PageQuery) =
        page(query) { it.ownerId == ownerId && it.folderId == null && it.deletedAt == null }

    override suspend fun findPageInFolder(folderId: Uuid, query: PageQuery) =
        page(query) { it.folderId == folderId && it.deletedAt == null }

    override suspend fun findAllInFolders(folderIds: Collection<Uuid>) = boards.values.filter { it.folderId in folderIds }

    override suspend fun findAllById(ids: Collection<Uuid>) = boards.values.filter { it.id in ids }

    override suspend fun findDeletedByOwner(ownerId: Uuid) = boards.values.filter { it.ownerId == ownerId && it.deletedAt != null }

    override suspend fun findDeletedBefore(before: Instant) = boards.values.filter { (it.deletedAt ?: Instant.DISTANT_FUTURE) < before }

    override suspend fun insert(board: Board): Board = board.copy(version = 0).also { boards[it.id] = it }

    override suspend fun update(board: Board): Board? {
        val stored = boards[board.id]
        if (failNextUpdate || stored == null || stored.version != board.version) {
            failNextUpdate = false
            return null
        }
        return board.copy(version = board.version + 1).also { boards[it.id] = it }
    }

    override suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?) {
        ids.forEach { id -> boards[id]?.let { boards[id] = it.copy(deletedAt = at) } }
    }

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        ids.forEach(boards::remove)
    }

    override suspend fun count(): Long = boards.values.count { it.deletedAt == null }.toLong()

    override suspend fun touch(id: Uuid, at: Instant) {
        boards[id]?.takeIf { it.updatedAt < at }?.let { boards[id] = it.copy(updatedAt = at) }
    }
}
