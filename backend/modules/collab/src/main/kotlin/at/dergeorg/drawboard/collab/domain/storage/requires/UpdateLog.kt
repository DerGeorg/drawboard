package at.dergeorg.drawboard.collab.domain.storage.requires

import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import kotlinx.coroutines.flow.Flow
import kotlin.uuid.Uuid

/** Persistence port of the update log, in domain terms only. Implemented in requires/impl (Spring Data R2DBC). */
internal interface UpdateLog {

    suspend fun append(update: LoggedUpdate)

    /** The entries with `seq > afterSeq`, ascending - streamed, a log can be large. */
    fun readAfter(boardId: Uuid, afterSeq: Long): Flow<LoggedUpdate>

    /** The highest `seq` of the board, or null if the log is empty. */
    suspend fun lastSeq(boardId: Uuid): Long?

    suspend fun countAfter(boardId: Uuid, afterSeq: Long): Long

    /** Bytes of the entries with `seq > afterSeq`. */
    suspend fun sizeAfter(boardId: Uuid, afterSeq: Long): Long

    /** Bytes of the logs of ALL boards - for the storage metric. */
    suspend fun totalSize(): Long

    /** Deletes the entries with `seq <= seq`. */
    suspend fun deleteUpTo(boardId: Uuid, seq: Long)

    suspend fun deleteAll(boardId: Uuid)
}
