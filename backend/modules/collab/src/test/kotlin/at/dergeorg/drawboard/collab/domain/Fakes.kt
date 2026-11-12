package at.dergeorg.drawboard.collab.domain

import at.dergeorg.drawboard.collab.domain.protocol.Lib0Reader
import at.dergeorg.drawboard.collab.domain.rooms.CollabMetrics
import at.dergeorg.drawboard.collab.domain.rooms.CompactionResult
import at.dergeorg.drawboard.collab.domain.rooms.DropReason
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabConnection
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardActivity
import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import at.dergeorg.drawboard.collab.domain.storage.requires.SnapshotStore
import at.dergeorg.drawboard.collab.domain.storage.requires.UpdateLog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.onStart
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** In-memory [UpdateLog]. [gate]: when set, `readAfter` waits for it - to let a test act in the middle of a join. */
internal class InMemoryUpdateLog : UpdateLog {
    val entries = mutableListOf<LoggedUpdate>()
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun append(update: LoggedUpdate) {
        check(entries.none { it.boardId == update.boardId && it.seq == update.seq }) { "duplicate seq ${update.seq}" }
        entries += update
    }

    override fun readAfter(boardId: Uuid, afterSeq: Long): Flow<LoggedUpdate> =
        entries.filter { it.boardId == boardId && it.seq > afterSeq }.sortedBy { it.seq }.asFlow().onStart { gate?.await() }

    override suspend fun lastSeq(boardId: Uuid): Long? = entries.filter { it.boardId == boardId }.maxOfOrNull { it.seq }

    override suspend fun countAfter(boardId: Uuid, afterSeq: Long): Long =
        entries.count { it.boardId == boardId && it.seq > afterSeq }.toLong()

    override suspend fun sizeAfter(boardId: Uuid, afterSeq: Long): Long =
        entries.filter { it.boardId == boardId && it.seq > afterSeq }.sumOf { it.data.size.toLong() }

    override suspend fun totalSize(): Long = entries.sumOf { it.data.size.toLong() }

    override suspend fun deleteUpTo(boardId: Uuid, seq: Long) {
        entries.removeAll { it.boardId == boardId && it.seq <= seq }
    }

    override suspend fun deleteAll(boardId: Uuid) {
        entries.removeAll { it.boardId == boardId }
    }
}

internal class InMemorySnapshotStore : SnapshotStore {
    val snapshots = mutableListOf<Pair<Uuid, StoredSnapshot>>()

    override suspend fun insert(snapshot: StoredSnapshot) {
        snapshots += Uuid.generateV7() to snapshot
    }

    override suspend fun findById(boardId: Uuid, id: Uuid): StoredSnapshot? =
        snapshots.firstOrNull { it.first == id && it.second.boardId == boardId }?.second

    override suspend fun findLatest(boardId: Uuid): StoredSnapshot? =
        snapshots.map { it.second }.filter { it.boardId == boardId }.maxByOrNull { it.upToSeq }

    override suspend fun listMeta(boardId: Uuid): List<SnapshotMeta> = snapshots.filter { it.second.boardId == boardId }
        .map { (id, s) -> SnapshotMeta(id, s.upToSeq, s.data.size, s.createdAt) }
        .sortedByDescending { it.upToSeq }

    override suspend fun totalSize(): Long = snapshots.sumOf { it.second.data.size.toLong() }

    override suspend fun delete(ids: Collection<Uuid>) {
        snapshots.removeAll { it.first in ids }
    }

    override suspend fun deleteAll(boardId: Uuid) {
        snapshots.removeAll { it.second.boardId == boardId }
    }
}

/** Roles by (board, user); a user not in the map has no role. */
internal class FakeBoardAccess : BoardAccess {
    val roles = mutableMapOf<Pair<Uuid, Uuid>, CollabRole>()
    var failing = false

    override suspend fun roleOf(boardId: Uuid, who: Participant): CollabRole? {
        val userId = who.userId
        check(!failing) { "library is down" }
        return roles[boardId to userId]
    }
}

internal class RecordingBoardActivity : BoardActivity {
    val changes = mutableListOf<Pair<Uuid, Instant>>()

    override suspend fun contentChanged(boardId: Uuid, at: Instant) {
        changes += boardId to at
    }
}

/** Fake of the [CollabMetrics] port: keeps what was reported. */
internal class RecordingCollabMetrics : CollabMetrics {
    val updates = mutableListOf<Int>()
    val drops = mutableListOf<DropReason>()
    val closes = mutableListOf<String>()
    val compactions = mutableListOf<CompactionResult>()
    val storage = mutableMapOf<String, Long>()

    override fun updateAccepted(bytes: Int) {
        updates += bytes
    }

    override fun dropped(reason: DropReason) {
        drops += reason
    }

    override fun closed(code: String) {
        closes += code
    }

    override fun compaction(result: CompactionResult) {
        compactions += result
    }

    override fun storageBytes(kind: String, bytes: Long) {
        storage[kind] = bytes
    }
}

/** What a test client sees: the frames queued for it so far. */
internal class TestClient(val connection: CollabConnection) {

    /** Takes every frame that is queued right now. */
    fun drain(): List<Frame> = generateSequence { connection.frames.tryReceive().getOrNull() }.map(::Frame).toList()

    val closeOrder get() = connection.closeOrder
}

/** A server frame, decoded just enough for assertions. */
internal class Frame(val bytes: ByteArray) {
    val type: Int = bytes[0].toInt() and 0xff

    private fun reader() = Lib0Reader(bytes, 1)

    val number: Long get() = reader().readVarUint()
    val text: String get() = reader().readVarString()

    /** For SNAPSHOT and UPDATE: the sequence number, then the bytes. */
    val seqAndData: Pair<Long, ByteArray> get() = reader().let { it.readVarUint() to it.readRest() }

    /** For AWARENESS: the sender JSON, then the payload. */
    val fromAndPayload: Pair<String, ByteArray> get() = reader().let { it.readVarString() to it.readRest() }

    companion object {
        const val WELCOME = 0x80
        const val SNAPSHOT = 0x81
        const val UPDATE = 0x82
        const val SYNCED = 0x83
        const val ACK = 0x84
        const val AWARENESS = 0x85
        const val PEER_JOINED = 0x86
        const val PEER_LEFT = 0x87
        const val COMPACT = 0x88
        const val PONG = 0x89
        const val ROLE = 0x8A
    }
}

internal fun List<Frame>.types(): List<Int> = map { it.type }
