package at.dergeorg.drawboard.collab.domain.storage.requires

import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotMeta
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import kotlin.uuid.Uuid

/** Persistence port of the snapshots. Implemented in requires/impl (Spring Data R2DBC). */
internal interface SnapshotStore {

    suspend fun insert(snapshot: StoredSnapshot)

    /** The snapshot [id] of the board, with its bytes - null if it does not exist or belongs to another board. */
    suspend fun findById(boardId: Uuid, id: Uuid): StoredSnapshot?

    /** The snapshot with the highest `upToSeq`, with its bytes. */
    suspend fun findLatest(boardId: Uuid): StoredSnapshot?

    /** All snapshots of the board WITHOUT their bytes, newest first. */
    suspend fun listMeta(boardId: Uuid): List<SnapshotMeta>

    /** Bytes of the snapshots of ALL boards - for the storage metric. */
    suspend fun totalSize(): Long

    suspend fun delete(ids: Collection<Uuid>)

    suspend fun deleteAll(boardId: Uuid)
}
