package at.dergeorg.drawboard.collab.domain.storage.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** One accepted Yjs update. [seq] is per board, starts at 1 and has no gaps. The server never reads [data]. */
internal class LoggedUpdate(
    val boardId: Uuid,
    val seq: Long,
    val data: ByteArray,
    val authorId: Uuid,
    val createdAt: Instant,
)

/** The whole drawing up to (at least) [upToSeq] as one Yjs update, uploaded by a client on request. */
internal class StoredSnapshot(
    val boardId: Uuid,
    val upToSeq: Long,
    val data: ByteArray,
    val createdBy: Uuid,
    val createdAt: Instant,
)

/** A snapshot without its bytes - what the retention needs. */
internal data class SnapshotMeta(val id: Uuid, val upToSeq: Long, val size: Int, val createdAt: Instant)
