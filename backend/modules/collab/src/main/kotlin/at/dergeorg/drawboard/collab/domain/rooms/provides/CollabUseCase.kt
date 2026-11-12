package at.dergeorg.drawboard.collab.domain.rooms.provides

import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import kotlin.uuid.Uuid

/**
 * What collab offers the WebSocket and REST layer (module api).
 *
 * Single replica: rooms, sequence numbers and tickets live in the memory of this process. Several replicas need the
 * PostgreSQL `LISTEN/NOTIFY` fan-out of S2.12 first.
 */
interface CollabUseCase {

    /**
     * Handshake, before the upgrade: redeems [ticket] (single use) for [boardId], resolves the user's role again and
     * checks the session limits (for a guest also the 50 sessions per [clientAddress], S2.5). Nothing is opened yet.
     */
    suspend fun admit(ticket: String, boardId: Uuid, clientAddress: String? = null): Admission

    /** Opens the session of an admitted handshake; joining (snapshot, log) continues in the background. */
    suspend fun open(admitted: Admission.Admitted): CollabConnection

    /**
     * The checks that come BEFORE the body of a snapshot upload is read, so that nobody makes the server read tens of
     * megabytes it will refuse anyway: `TOO_MANY_REQUESTS` (429, `Retry-After`) after 10 attempts per minute and user,
     * and `COLLAB_SNAPSHOT_NOT_REQUESTED` (409) unless the server has an open request for exactly this user, board and
     * sequence number. The request is not consumed; [storeSnapshot] does that.
     */
    suspend fun checkSnapshotUpload(userId: Uuid, boardId: Uuid, upToSeq: Long)

    /**
     * Stores a snapshot the server asked [StoreSnapshotCommand.userId] for: `COLLAB_SNAPSHOT_NOT_REQUESTED` (409) if
     * there is no open request of this user for exactly this sequence number, `PAYLOAD_TOO_LARGE` (413) above the
     * limit. Applies the retention and drops the log the snapshot replaces.
     */
    suspend fun storeSnapshot(command: StoreSnapshotCommand)

    /** The board went to the trash: closes its sessions with 4404; log and snapshots stay for a restore. */
    suspend fun closeSessions(boardId: Uuid)

    /**
     * Access rules changed (a grant, a share, a move, the trash - S2.3): every open session resolves its role again at
     * once. A lower role is sent as a ROLE frame, a lost one closes the session with 4403.
     */
    suspend fun recheckAll()

    /** The kept versions of the board (its snapshots), newest first, without their bytes. */
    suspend fun listVersions(boardId: Uuid): List<VersionView>

    /**
     * Makes version [versionId] the board's new base (S2.8): it is stored as a NEW snapshot with a sequence number
     * above everything that exists (a new epoch), and the update log is dropped. Audited. `COLLAB_VERSION_NOT_FOUND`
     * (404) for an unknown version. Call it between [beginReplace] and [endReplace]: no session can write to the log
     * while it is replaced.
     */
    suspend fun restoreVersion(command: RestoreVersionCommand)

    /**
     * The document of the board is about to be replaced: closes every session with 4410 "document replaced"
     * (docs/collab-protocol.md) and refuses new joins (the handshake answers 429, clients retry) until [endReplace] -
     * so nothing can be appended to the log while the restore rewrites it.
     */
    suspend fun beginReplace(boardId: Uuid)

    /** The replacement is committed (or abandoned): joins are accepted again and read the new state. */
    suspend fun endReplace(boardId: Uuid)

    /** The board is deleted for good: closes its sessions with 4404 and deletes log and snapshots. */
    suspend fun deleteBoardData(boardId: Uuid)
}

/** Input of [CollabUseCase.storeSnapshot]; [data] is the whole drawing as one Yjs update. */
class StoreSnapshotCommand(val userId: Uuid, val boardId: Uuid, val upToSeq: Long, val data: ByteArray)

/** A kept version of a board: [id] is the snapshot's id, [upToSeq] the log position it covers, [size] its bytes. */
data class VersionView(val id: Uuid, val upToSeq: Long, val createdAt: kotlin.time.Instant, val size: Long)

/** Input of [CollabUseCase.restoreVersion]: [userId] is the owner who restores (recorded as the snapshot's creator). */
data class RestoreVersionCommand(val userId: Uuid, val boardId: Uuid, val versionId: Uuid)
