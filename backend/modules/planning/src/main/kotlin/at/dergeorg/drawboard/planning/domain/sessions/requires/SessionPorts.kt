package at.dergeorg.drawboard.planning.domain.sessions.requires

import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Port: the sessions. */
internal interface SessionRepository {

    /** The session, but only if it belongs to [boardId] - a session of another board does not exist for the caller. */
    suspend fun find(boardId: Uuid, sessionId: Uuid): StoredSession?

    suspend fun findAllById(ids: Collection<Uuid>): List<StoredSession>

    suspend fun insert(session: StoredSession)

    /**
     * Writes the changing columns of [after] (state, round, times, version) - only if the row still has the version of [before]:
     * another writer (a second replica, E15) makes this fail loudly with 409 `CONFLICT` instead of losing a transition.
     */
    suspend fun update(before: StoredSession, after: StoredSession)

    /** Newest first, at most [limit]. */
    suspend fun findNewest(boardId: Uuid, states: Collection<SessionState>, limit: Int): List<StoredSession>

    /** Oldest closed first (by the time they were closed), at most [limit]. */
    suspend fun findOldest(boardId: Uuid, state: SessionState, limit: Int): List<StoredSession>

    suspend fun count(boardId: Uuid, states: Collection<SessionState>): Int

    /** DONE sessions closed before [closedBefore] that the retention purge has not reduced yet, at most [limit]. */
    suspend fun findExpired(closedBefore: Instant, limit: Int): List<StoredSession>

    /** Deletes the sessions; their seats, cards, entries and moves must be gone already. */
    suspend fun deleteAll(ids: Collection<Uuid>)

    /** The ids of every session of these boards, in any state. */
    suspend fun idsOfBoards(boardIds: Collection<Uuid>): List<Uuid>
}

/** Port: the seats. */
internal interface SeatRepository {

    /** In the order they joined. */
    suspend fun findBySession(sessionId: Uuid): List<StoredSeat>

    suspend fun findBySessions(sessionIds: Collection<Uuid>): List<StoredSeat>

    suspend fun findOwn(sessionId: Uuid, kind: ParticipantKind, principalId: Uuid): StoredSeat?

    /** [seat] is new: false if its (session, kind, principal) exists already (a concurrent join won). */
    suspend fun insert(seat: StoredSeat): Boolean

    suspend fun updateAll(seats: Collection<StoredSeat>)

    /** Every seat of a guest link, in any session. */
    suspend fun findByShare(shareId: Uuid): List<StoredSeat>

    suspend fun deleteAll(ids: Collection<Uuid>)

    suspend fun deleteBySessions(sessionIds: Collection<Uuid>)

    /** Drops the slots of every seat of the session (REVIEW, E5). */
    suspend fun clearSlots(sessionId: Uuid)
}

/** Port: the cards of the sessions. */
internal interface ItemRepository {

    /** In the order given at creation. */
    suspend fun findBySession(sessionId: Uuid): List<StoredItem>

    suspend fun find(sessionId: Uuid, itemId: Uuid): StoredItem?

    suspend fun insertAll(items: List<StoredItem>)

    suspend fun updateAll(items: Collection<StoredItem>)

    suspend fun deleteBySessions(sessionIds: Collection<Uuid>)
}

/** Port: the Rotation entries. */
internal interface EntryRepository {

    /** In the stored random order (`shuffle`). */
    suspend fun findBySession(sessionId: Uuid): List<StoredEntry>

    suspend fun insert(entry: StoredEntry)

    suspend fun update(entry: StoredEntry)

    suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid)

    suspend fun deleteBySessions(sessionIds: Collection<Uuid>)

    /**
     * Drops the seat and the time of every entry of the session (anonymous REVIEW, E5), and the reasons too when [reasons] (retention,
     * E22).
     */
    suspend fun unlink(sessionId: Uuid, reasons: Boolean)
}

/** Port: the Magic moves. */
internal interface MoveRepository {

    /** Every move of the session, in their order (`seq`). */
    suspend fun findBySession(sessionId: Uuid): List<StoredMove>

    /** Every move of one card, in their order (`seq`). */
    suspend fun findByItem(itemId: Uuid): List<StoredMove>

    /** The order number of the next move of the session. */
    suspend fun nextSeq(sessionId: Uuid): Long

    suspend fun countBySeat(sessionId: Uuid, seatId: Uuid): Int

    suspend fun countBySession(sessionId: Uuid): Int

    suspend fun insert(move: StoredMove)

    suspend fun update(move: StoredMove)

    suspend fun delete(id: Uuid)

    suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid)

    suspend fun deleteBySessions(sessionIds: Collection<Uuid>)

    /** Drops the seat and the time of every move of the session (REVIEW, E4/E5: the mover is never named); `seq` keeps the order. */
    suspend fun unlink(sessionId: Uuid)
}

/** Port: the numbers about estimation sessions that Grafana shows. Fixed labels only (S7.10), never a board, a user or a value. */
internal interface EstimationMetrics {

    /** [event]: `created`, `started`, `finished`, `cancelled`, `idle_cancelled`; [mode]: `magic` or `rotation`. */
    fun session(event: String, mode: String)

    /** [kind]: `placement`, `move` or `estimate` - one input of a seat, never its value. */
    fun input(kind: String)

    /** A request refused by a limit ([reason]: `rate_limit`, `session_full`, `move_limit`, `session_limit`) - E17. */
    fun refused(reason: String)
}
