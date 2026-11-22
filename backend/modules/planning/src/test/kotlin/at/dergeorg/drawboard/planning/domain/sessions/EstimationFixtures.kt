package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.DirectTransactions
import at.dergeorg.drawboard.planning.domain.EstimationPlayService
import at.dergeorg.drawboard.planning.domain.EstimationService
import at.dergeorg.drawboard.planning.domain.FakeGuestShares
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRefKind
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import at.dergeorg.drawboard.planning.domain.sessions.provides.GetSessionQuery
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewItemSpec
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewSessionCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionAnswer
import at.dergeorg.drawboard.planning.domain.sessions.provides.StartCommand
import at.dergeorg.drawboard.planning.domain.sessions.requires.EntryRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.EstimationMetrics
import at.dergeorg.drawboard.planning.domain.sessions.requires.ItemRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.MoveRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SeatRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SessionRepository
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlin.test.assertIs
import kotlin.time.Instant
import kotlin.uuid.Uuid

internal class InMemorySessions : SessionRepository {
    val rows = linkedMapOf<Uuid, StoredSession>()
    var updates = 0

    override suspend fun find(boardId: Uuid, sessionId: Uuid) = rows[sessionId]?.takeIf { it.boardId == boardId }

    override suspend fun findAllById(ids: Collection<Uuid>) = ids.mapNotNull { rows[it] }

    override suspend fun insert(session: StoredSession) {
        check(session.id !in rows) { "duplicate id" }
        rows[session.id] = session
    }

    override suspend fun update(before: StoredSession, after: StoredSession) {
        // the version guard of the adapter: a second writer fails loudly
        if (rows[before.id]?.version != before.version) throw DomainException(ErrorCode.CONFLICT)
        rows[after.id] = after
        updates++
    }

    override suspend fun findNewest(boardId: Uuid, states: Collection<SessionState>, limit: Int) =
        rows.values.filter { it.boardId == boardId && it.state in states }.sortedWith(compareBy({ it.createdAt }, { it.id })).reversed()
            .take(limit)

    override suspend fun findOldest(boardId: Uuid, state: SessionState, limit: Int) =
        rows.values.filter { it.boardId == boardId && it.state == state }.sortedWith(compareBy({ it.closedAt }, { it.id })).take(limit)

    override suspend fun count(boardId: Uuid, states: Collection<SessionState>) =
        rows.values.count { it.boardId == boardId && it.state in states }

    override suspend fun findExpired(closedBefore: Instant, limit: Int) = rows.values.filter {
        it.state == SessionState.DONE && it.reducedAt == null && it.closedAt != null && it.closedAt!! < closedBefore
    }.take(limit)

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        rows.keys.removeAll(ids.toSet())
    }

    override suspend fun idsOfBoards(boardIds: Collection<Uuid>) = rows.values.filter { it.boardId in boardIds }.map { it.id }
}

internal class InMemorySeats : SeatRepository {
    val rows = linkedMapOf<Uuid, StoredSeat>()

    override suspend fun findBySession(sessionId: Uuid) = rows.values.filter { it.sessionId == sessionId }.sortedBy { it.position }

    override suspend fun findBySessions(sessionIds: Collection<Uuid>) =
        rows.values.filter { it.sessionId in sessionIds }.sortedBy { it.position }

    override suspend fun findOwn(sessionId: Uuid, kind: ParticipantKind, principalId: Uuid) =
        rows.values.firstOrNull { it.sessionId == sessionId && it.kind == kind && it.principalId == principalId }

    override suspend fun insert(seat: StoredSeat): Boolean {
        if (findOwn(seat.sessionId, seat.kind, seat.principalId) != null) return false
        rows[seat.id] = seat
        return true
    }

    override suspend fun updateAll(seats: Collection<StoredSeat>) {
        seats.forEach { rows[it.id] = it }
    }

    override suspend fun findByShare(shareId: Uuid) = rows.values.filter { it.shareId == shareId }

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        rows.keys.removeAll(ids.toSet())
    }

    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        rows.values.removeAll { it.sessionId in sessionIds }
    }

    override suspend fun clearSlots(sessionId: Uuid) {
        rows.replaceAll { _, seat -> if (seat.sessionId == sessionId) seat.copy(slot = null) else seat }
    }
}

internal class InMemoryItems : ItemRepository {
    val rows = linkedMapOf<Uuid, StoredItem>()

    override suspend fun findBySession(sessionId: Uuid) = rows.values.filter { it.sessionId == sessionId }.sortedBy { it.position }

    override suspend fun find(sessionId: Uuid, itemId: Uuid) = rows[itemId]?.takeIf { it.sessionId == sessionId }

    override suspend fun insertAll(items: List<StoredItem>) {
        items.forEach { rows[it.id] = it }
    }

    override suspend fun updateAll(items: Collection<StoredItem>) {
        items.forEach { rows[it.id] = it }
    }

    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        rows.values.removeAll { it.sessionId in sessionIds }
    }
}

internal class InMemoryEntries : EntryRepository {
    val rows = linkedMapOf<Uuid, StoredEntry>()

    override suspend fun findBySession(sessionId: Uuid) =
        rows.values.filter { it.sessionId == sessionId }.sortedWith(compareBy({ it.shuffle }, { it.id }))

    override suspend fun insert(entry: StoredEntry) {
        check(rows.values.none { it.itemId == entry.itemId && it.round == entry.round }) { "the unique key: one entry per card and round" }
        rows[entry.id] = entry
    }

    override suspend fun update(entry: StoredEntry) {
        rows[entry.id] = entry
    }

    override suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid) {
        rows.values.removeAll { it.sessionId == sessionId && it.seatId == seatId }
    }

    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        rows.values.removeAll { it.sessionId in sessionIds }
    }

    override suspend fun unlink(sessionId: Uuid, reasons: Boolean) {
        rows.replaceAll { _, entry ->
            if (entry.sessionId != sessionId) entry else entry.copy(
                seatId = null,
                createdAt = null,
                reason = if (reasons) null else entry.reason,
            )
        }
    }
}

internal class InMemoryMoves : MoveRepository {
    val rows = linkedMapOf<Uuid, StoredMove>()

    override suspend fun findBySession(sessionId: Uuid) =
        rows.values.filter { it.sessionId == sessionId }.sortedBy { it.seq }

    override suspend fun findByItem(itemId: Uuid) = rows.values.filter { it.itemId == itemId }.sortedBy { it.seq }

    override suspend fun nextSeq(sessionId: Uuid) = (rows.values.filter { it.sessionId == sessionId }.maxOfOrNull { it.seq } ?: 0) + 1

    override suspend fun countBySeat(sessionId: Uuid, seatId: Uuid) = rows.values.count { it.sessionId == sessionId && it.seatId == seatId }

    override suspend fun countBySession(sessionId: Uuid) = rows.values.count { it.sessionId == sessionId }

    override suspend fun insert(move: StoredMove) {
        rows[move.id] = move
    }

    override suspend fun update(move: StoredMove) {
        rows[move.id] = move
    }

    override suspend fun delete(id: Uuid) {
        rows.remove(id)
    }

    override suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid) {
        rows.values.removeAll { it.sessionId == sessionId && it.seatId == seatId }
    }

    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        rows.values.removeAll { it.sessionId in sessionIds }
    }

    override suspend fun unlink(sessionId: Uuid) {
        rows.replaceAll { _, move -> if (move.sessionId == sessionId) move.copy(seatId = null, at = null) else move }
    }
}

internal class RecordingEstimationMetrics : EstimationMetrics {
    val sessions = mutableListOf<String>()
    val inputs = mutableListOf<String>()
    val refused = mutableListOf<String>()

    override fun session(event: String, mode: String) {
        sessions += "$event/$mode"
    }

    override fun input(kind: String) {
        inputs += kind
    }

    override fun refused(reason: String) {
        refused += reason
    }
}

/** One estimation module on fakes: both services on one keeper, a clock the test moves, a board, a moderator and a few members. */
internal class EstimationWorld(val limits: EstimationLimits = EstimationLimits()) {
    val clock = MutableClock()
    val sessions = InMemorySessions()
    val seats = InMemorySeats()
    val items = InMemoryItems()
    val entries = InMemoryEntries()
    val moves = InMemoryMoves()
    val audit = RecordingAuditTrail()
    val metrics = RecordingEstimationMetrics()
    val shares = FakeGuestShares()
    val keeper = SessionKeeper(sessions, seats, items, entries, moves, DirectTransactions, clock, limits, metrics, audit, shares)
    val service = EstimationService(keeper)
    val play = EstimationPlayService(keeper)
    val board: Uuid = Uuid.generateV7()
    val share: Uuid = Uuid.generateV7()

    val moderator = Principal.Member(Uuid.generateV7(), "Mona")
    val anna = Principal.Member(Uuid.generateV7(), "Anna")
    val ben = Principal.Member(Uuid.generateV7(), "Ben")
    val cleo = Principal.Member(Uuid.generateV7(), "Cleo")
    val owner = Principal.Member(Uuid.generateV7(), "Olga")

    fun guest(name: String = "Gus", shareId: Uuid = share) = Principal.Guest(Uuid.random(), name, shareId)

    /** A member who takes part (COMMENTER or EDITOR, not the moderator). */
    fun viewer(principal: Principal) = Viewer(principal, editor = false, owner = false)

    val moderatorView = Viewer(moderator, editor = true, owner = false)
    val ownerView = Viewer(owner, editor = true, owner = true)

    fun cards(count: Int) = List(count) { NewItemSpec(ItemRef(ItemRefKind.STORY, Uuid.random().toString(), null), "Story $it") }

    val magicSettings = SessionSettings(placingSeconds = 60, movingSeconds = 120)

    fun rotationSettings(rounds: Int = 2, advanceWhenDone: Boolean? = false) =
        SessionSettings(rounds = rounds, roundSeconds = 60, advanceWhenDone = advanceWhenDone)

    suspend fun create(
        mode: EstimationMode = EstimationMode.ROTATION,
        items: Int = 4,
        settings: SessionSettings = if (mode == EstimationMode.MAGIC) magicSettings else rotationSettings(),
        anonymous: Boolean? = null,
        deck: DeckSpec = DeckSpec(DeckKind.FIBONACCI, null),
        on: Uuid = board,
    ): SessionView = service.create(NewSessionCommand(on, moderator, mode, " Sprint 42 ", deck, cards(items), anonymous, settings))

    /** Joins everybody in [who] and starts with all of them. */
    suspend fun started(session: SessionView, vararg who: Principal): SessionView {
        who.forEach { service.join(board, session.id, it) }
        val ids = seats.findBySession(session.id).map { it.id }.toSet()
        return service.start(StartCommand(board, session.id, moderatorView, ids))
    }

    suspend fun look(session: SessionView, viewer: Viewer): SessionView =
        assertIs<SessionAnswer.Found>(service.get(GetSessionQuery(board, session.id, viewer) { false }), "a full answer").session

    fun stored(session: SessionView): StoredSession = checkNotNull(sessions.rows[session.id])

    fun seatOf(session: SessionView, principal: Principal): StoredSeat =
        seats.rows.values.single { it.sessionId == session.id && it.principalId == principal.id }

    /** The cards [principal] works on now (by the secret ring), in position order. */
    suspend fun mine(session: SessionView, principal: Principal): List<StoredItem> {
        val stored = stored(session)
        val all = seats.findBySession(session.id)
        val seat = seatOf(session, principal)
        return items.findBySession(session.id).filter { Ring.holds(stored, all, seat, it) }
    }

    suspend fun notMine(session: SessionView, principal: Principal): List<StoredItem> {
        val own = mine(session, principal).map { it.id }.toSet()
        return items.findBySession(session.id).filter { it.id !in own }
    }
}

// --- builders for the tests of the pure rules ---------------------------------------------------------------------------------

internal val T0: Instant = Instant.parse("2026-11-19T10:00:00Z")

internal fun aSession(
    mode: EstimationMode = EstimationMode.ROTATION,
    state: SessionState = SessionState.LOBBY,
    round: Int = 0,
    phaseEndsAt: Instant? = null,
    settings: SessionSettings = if (mode == EstimationMode.MAGIC) {
        SessionSettings(placingSeconds = 60, movingSeconds = 120, markThreshold = 3)
    } else {
        SessionSettings(rounds = 3, roundSeconds = 60, advanceWhenDone = true)
    },
    anonymous: Boolean = true,
    items: Int = 4,
    lastActivityAt: Instant = T0,
    closedAt: Instant? = null,
) = StoredSession(
    id = Uuid.generateV7(), boardId = Uuid.generateV7(), mode = mode, title = "Sprint",
    deck = at.dergeorg.drawboard.planning.domain.rounds.model.Deck.FIBONACCI, anonymous = anonymous, settings = settings, state = state,
    round = round, phaseEndsAt = phaseEndsAt, moderatorId = Uuid.generateV7(), moderatorName = "Mona", itemCount = items, createdAt = T0,
    startedAt = null, closedAt = closedAt, lastActivityAt = lastActivityAt, reducedAt = null, version = 1,
)

internal fun aSeat(session: StoredSession, principal: Principal, slot: Int?, position: Int = (slot ?: 0) + 1, seated: Boolean = true) =
    StoredSeat(
        id = Uuid.random(), sessionId = session.id,
        kind = if (principal is Principal.Guest) ParticipantKind.GUEST else ParticipantKind.USER,
        principalId = principal.id, shareId = (principal as? Principal.Guest)?.shareId, displayName = principal.displayName,
        position = position, joinedAt = T0, seated = seated, slot = slot, removed = false,
    )

internal fun anItem(session: StoredSession, position: Int, column: String? = null, marked: Boolean = false) = StoredItem(
    id = Uuid.generateV7(), sessionId = session.id, position = position,
    ref = ItemRef(ItemRefKind.STORY, Uuid.random().toString(), null), title = "Story $position", column = column, moveCount = 0,
    marked = marked, touched = false, decision = null, overridden = false,
)

internal fun anEntry(item: StoredItem, seat: StoredSeat?, round: Int, value: String, reason: String? = null, shuffle: Long = 0) =
    StoredEntry(
        id = Uuid.generateV7(), sessionId = item.sessionId, itemId = item.id, seatId = seat?.id, round = round, value = value,
        reason = reason, kept = false, shuffle = shuffle, createdAt = T0,
    )

internal fun aMove(item: StoredItem, seat: StoredSeat?, from: String?, to: String, at: Instant = T0, seq: Long = 0) = StoredMove(
    id = Uuid.random(), sessionId = item.sessionId, itemId = item.id, seatId = seat?.id, fromValue = from, toValue = to, at = at, seq = seq,
)
