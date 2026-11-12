package at.dergeorg.drawboard.library.domain.boards.requires

import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Persistence port of boards, in domain terms only. Implemented in requires/impl (Spring Data R2DBC). */
internal interface BoardRepository {

    suspend fun findById(id: Uuid): Board?

    /** Like [findById], but the row stays locked until the transaction ends - for changes that must not race. */
    suspend fun findForUpdate(id: Uuid): Board?

    /** The boards of [ownerId] in the root of their space (no folder), not in the trash, most recently changed first. */
    suspend fun findPageInRoot(ownerId: Uuid, query: PageQuery): Page<Board>

    /** The boards directly in [folderId], not in the trash, most recently changed first. */
    suspend fun findPageInFolder(folderId: Uuid, query: PageQuery): Page<Board>

    /** The boards in any of [folderIds], trash or not. */
    suspend fun findAllInFolders(folderIds: Collection<Uuid>): List<Board>

    suspend fun findAllById(ids: Collection<Uuid>): List<Board>

    /** The boards of [ownerId] that are in the trash. */
    suspend fun findDeletedByOwner(ownerId: Uuid): List<Board>

    /** Boards in the trash since before [before] - for the cleanup. */
    suspend fun findDeletedBefore(before: Instant): List<Board>

    /** Stores a new board; it comes back with its first version. */
    suspend fun insert(board: Board): Board

    /**
     * Stores the changes of [board] if the stored version is still `board.version` and returns it with the next
     * version - or null if a concurrent request changed or deleted it in between (optimistic lock).
     */
    suspend fun update(board: Board): Board?

    /** Sets or clears (`at` null) `deletedAt` of all [ids] without touching their versions. */
    suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?)

    suspend fun deleteAll(ids: Collection<Uuid>)

    /** All boards that are not in the trash - for the gauge `drawboard.boards`. */
    suspend fun count(): Long

    /** Raises `updatedAt` of the board to [at] if that is later than the stored value; the version stays. No-op if the board is gone. */
    suspend fun touch(id: Uuid, at: Instant)
}
