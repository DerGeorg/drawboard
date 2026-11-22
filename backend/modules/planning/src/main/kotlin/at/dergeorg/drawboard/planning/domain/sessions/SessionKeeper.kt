package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.common.PlanningModule
import at.dergeorg.drawboard.planning.domain.common.KeyedLocks
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.requires.GuestShares
import at.dergeorg.drawboard.planning.domain.rounds.requires.Transactions
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCancelled
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionOperation
import at.dergeorg.drawboard.planning.domain.sessions.requires.EntryRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.EstimationMetrics
import at.dergeorg.drawboard.planning.domain.sessions.requires.ItemRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.MoveRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SeatRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SessionRepository
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import org.springframework.stereotype.Component
import java.security.SecureRandom
import kotlin.random.asKotlinRandom
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

/**
 * What the two estimation services share: the ports, the locks, the rate limits, the server clock with its side effects, the guest
 * rule E9, the revocation of seats and the one view mapper. Not a use case - [at.dergeorg.drawboard.planning.domain.EstimationService]
 * and [at.dergeorg.drawboard.planning.domain.EstimationPlayService] are.
 *
 * Locks (E15): one replica; the writes to one session run one after the other under [sessionLocks], the creation of a session on a
 * board under [boardLocks] - two instances, and a session lock is never held while a board lock is taken (board -> session only).
 * Every transition is applied under the session lock after the clock was read again, so many polls at a deadline make one
 * transition; every update names the version it read, so a second replica would fail loudly instead.
 */
@Component
@Suppress("TooManyFunctions", "LongParameterList")
internal class SessionKeeper(
    val sessions: SessionRepository,
    val seats: SeatRepository,
    val items: ItemRepository,
    val entries: EntryRepository,
    val moves: MoveRepository,
    val transactions: Transactions,
    val clock: Clock,
    val limits: EstimationLimits,
    val metrics: EstimationMetrics,
    private val audit: AuditTrail,
    private val guestShares: GuestShares,
) {

    val sessionLocks = KeyedLocks()
    val boardLocks = KeyedLocks()

    /** Slots (E2) and the order of the entries in REVIEW (E5). */
    val random = SecureRandom().asKotlinRandom()

    private val events = DomainEvents(PlanningModule.NAME)

    val creates = limiter(limits.createsPerMinute)
    val lists = limiter(limits.listsPerMinute)
    val shareLists = limiter(limits.shareListsPerMinute)
    val gets = limiter(limits.getsPerMinute)
    val shareGets = limiter(limits.shareGetsPerMinute)
    val seatChanges = limiter(limits.seatChangesPerMinute)
    val shareSeatChanges = limiter(limits.shareSeatChangesPerMinute)
    val placements = limiter(limits.placementsPerMinute)
    val sharePlacements = limiter(limits.sharePlacementsPerMinute)
    val estimates = limiter(limits.estimatesPerMinute)
    val shareEstimates = limiter(limits.shareEstimatesPerMinute)
    val moderatorOps = limiter(limits.moderatorOpsPerMinute)

    private fun limiter(perMinute: Int) = WindowRateLimiter(clock, RateRule(perMinute, 1.minutes))

    // --- finding --------------------------------------------------------------------------------------------------------------

    suspend fun find(boardId: Uuid, sessionId: Uuid): StoredSession = sessions.find(boardId, sessionId) ?: throw notFound(sessionId)

    /** The session with every due transition applied: read without a lock, settled under the session lock when something is due. */
    suspend fun settled(boardId: Uuid, sessionId: Uuid): StoredSession {
        val session = find(boardId, sessionId)
        if (!SessionClock.due(session, clock.now())) return session
        return sessionLocks.withLock(sessionId) { settleLocked(boardId, sessionId) }
    }

    /** [settled] for a caller that holds the session lock already: reads the session and the clock again (E15). */
    suspend fun settleLocked(boardId: Uuid, sessionId: Uuid): StoredSession {
        val session = find(boardId, sessionId)
        val now = clock.now()
        if (!SessionClock.due(session, now)) return session
        val settlement = SessionClock.settle(session, now)
        // the links are library's: asked outside the transaction, under the lock
        val revoked = if (SessionState.REVIEW in settlement.entered) revokedShares(session.id) else emptySet()
        transactions.required { apply(session, settlement, revoked) }
        return settlement.session
    }

    /**
     * Writes a settlement or an early advance, with what each entered state brings: MOVING marks the Magic cards without a column,
     * REVIEW drops seats of revoked links (safety net, E11), freezes the marks and the mapping of seats to entries and moves (E5),
     * CANCELLED deletes entries, reasons, moves and placements at once (E22). Inside a transaction, under the session lock.
     */
    suspend fun apply(before: StoredSession, settlement: Settlement, revoked: Set<Uuid>) {
        var previous = before.state
        for (state in settlement.entered) {
            when (state) {
                SessionState.MOVING -> remark(before, items.findBySession(before.id))
                SessionState.REVIEW -> enterReview(before.copy(state = previous), revoked)
                SessionState.CANCELLED -> cancelled(before, idle = settlement.idleCancelled)
                else -> Unit
            }
            previous = state
        }
        sessions.update(before, settlement.session)
    }

    /** E9: a guest sees a session in REVIEW, DONE or CANCELLED only while holding a seat in it - else 404 with the session id only. */
    suspend fun requireVisible(session: StoredSession, principal: Principal) {
        if (principal !is Principal.Guest || session.state !in SessionState.FOR_SEATED_GUESTS) return
        val own = own(session.id, principal)
        if (own == null || own.removed) throw notFound(session.id)
    }

    suspend fun own(sessionId: Uuid, principal: Principal): StoredSeat? =
        seats.findOwn(sessionId, if (principal is Principal.Guest) ParticipantKind.GUEST else ParticipantKind.USER, principal.id)

    /** A card of the session; 404 `PLANNING_SESSION_NOT_FOUND` with `itemId` otherwise. */
    suspend fun item(session: StoredSession, itemId: Uuid): StoredItem = items.find(session.id, itemId)
        ?: throw DomainException(
            ErrorCode.PLANNING_SESSION_NOT_FOUND,
            mapOf("sessionId" to session.id.toString(), "itemId" to itemId.toString()),
        )

    /** The caller's seat when it takes part; 403 `PLANNING_NOT_SEATED` otherwise (watchers, no seat, removed). */
    suspend fun seated(session: StoredSession, principal: Principal): StoredSeat {
        val own = own(session.id, principal)
        if (own == null || own.removed || !own.seated) {
            throw DomainException(ErrorCode.PLANNING_NOT_SEATED, mapOf("sessionId" to session.id.toString()))
        }
        return own
    }

    // --- views ----------------------------------------------------------------------------------------------------------------

    /** The session as [viewer] sees it, through the one mapper (E2-E5, E9); loads only what the state shows. */
    suspend fun view(session: StoredSession, viewer: Viewer): SessionView {
        val now = clock.now()
        val rotation = session.mode == EstimationMode.ROTATION
        val withEntries = rotation && (session.state == SessionState.ROTATING || session.state.revealed)
        val withMoves = !rotation && session.state.revealed && !SessionViews.reduced(session, now)
        val snapshot = Snapshot(
            session = session,
            seats = seats.findBySession(session.id),
            items = items.findBySession(session.id),
            entries = if (withEntries) entries.findBySession(session.id) else emptyList(),
            moves = if (withMoves) moves.findBySession(session.id) else emptyList(),
        )
        return SessionViews.view(snapshot, viewer, now) ?: throw notFound(session.id)
    }

    // --- writing --------------------------------------------------------------------------------------------------------------

    /** Raises the version (something everyone may notice changed) and counts the activity. */
    suspend fun raise(session: StoredSession): StoredSession {
        val raised = session.copy(version = session.version + 1, lastActivityAt = clock.now())
        sessions.update(session, raised)
        return raised
    }

    /** Counts the activity without raising the version (E3: a placement or entry that flips nothing). */
    suspend fun touch(session: StoredSession): StoredSession {
        val touched = session.copy(lastActivityAt = clock.now())
        sessions.update(session, touched)
        return touched
    }

    /**
     * Seats of revoked links leave (E11): in LOBBY they are deleted; in a running phase they are marked removed and what they entered
     * goes - Rotation entries and reasons; Magic placements (a card dealt to them loses the column they gave it, unless somebody moved
     * it since) and moves (the column follows the moves that are left) - and every card they placed, moved or estimated is touched
     * (Magic: marked). From REVIEW on the record stands. True when something changed.
     */
    suspend fun dropSeats(session: StoredSession, gone: List<StoredSeat>): Boolean {
        if (gone.isEmpty()) return false
        if (session.state == SessionState.LOBBY) {
            seats.deleteAll(gone.map { it.id })
            return true
        }
        if (!session.state.running) return false
        val all = seats.findBySession(session.id)
        seats.updateAll(gone.map { it.copy(removed = true) })
        val cards = items.findBySession(session.id)
        val changed = when (session.mode) {
            EstimationMode.MAGIC -> dropMagic(session, all, gone, cards)
            EstimationMode.ROTATION -> dropRotation(session, gone, cards)
        }
        items.updateAll(changed)
        return true
    }

    /**
     * ROTATION with `advanceWhenDone`: the round ends as soon as every seat taking part is done - removed seats never hold it up
     * (E11). Inside the transaction, under the session lock; returns the session as it is afterwards.
     */
    suspend fun advanceIfDone(session: StoredSession): StoredSession {
        if (session.state != SessionState.ROTATING || session.settings.advanceWhenDone != true) return session
        val all = seats.findBySession(session.id)
        val holders = all.filter { it.inRing }
        val cards = items.findBySession(session.id)
        val list = entries.findBySession(session.id)
        if (holders.isEmpty() || holders.any { !Progress.done(session, all, it, cards, list) }) return session
        val next = SessionClock.next(session, clock.now())
        val revoked = if (next.state == SessionState.REVIEW) revokedShares(session.id) else emptySet()
        apply(session, Settlement(next, listOf(next.state), idleCancelled = false), revoked)
        return next
    }

    /** The links among the seats of the session that are gone now (S1.13); asked of library through the port. */
    suspend fun revokedShares(sessionId: Uuid): Set<Uuid> {
        val shares = seats.findBySession(sessionId).filter { !it.removed }.mapNotNull { it.shareId }.toSet()
        return if (shares.isEmpty()) emptySet() else guestShares.revoked(shares)
    }

    /**
     * CANCELLED (by the moderator or idle): entries, reasons, moves, placements, decisions, the marks of removed seats and the slots are
     * deleted at once (E22). Audited.
     */
    suspend fun cancelled(session: StoredSession, idle: Boolean) {
        entries.deleteBySessions(listOf(session.id))
        moves.deleteBySessions(listOf(session.id))
        items.updateAll(
            items.findBySession(session.id).map {
                it.copy(column = null, moveCount = 0, marked = false, touched = false, decision = null, overridden = false)
            },
        )
        seats.clearSlots(session.id) // nothing of the ring is kept either
        record(session, AuditAction.UPDATED, "cancelled", SessionCancelled(session.boardId.toString(), idle))
        metrics.session(if (idle) "idle_cancelled" else "cancelled", modeLabel(session))
    }

    suspend fun record(session: StoredSession, action: AuditAction, name: String, details: DomainEventDetails) {
        audit.record(events.of(SESSION, session.id, action, name, details))
    }

    /** Deletes sessions with everything in them, children first. */
    suspend fun deleteSessions(ids: Collection<Uuid>) {
        if (ids.isEmpty()) return
        entries.deleteBySessions(ids)
        moves.deleteBySessions(ids)
        items.deleteBySessions(ids)
        seats.deleteBySessions(ids)
        sessions.deleteAll(ids)
    }

    // --- limits and errors ----------------------------------------------------------------------------------------------------

    /**
     * The rate of a caller on a session, taken before anything else is looked at (C3 SHOULD): an id that is no session of the board counts
     * under one key per caller, so probing ids is limited as well. 404 for an unknown session.
     */
    suspend fun limited(
        perUser: WindowRateLimiter,
        perShare: WindowRateLimiter,
        who: Principal,
        boardId: Uuid,
        sessionId: Uuid,
    ): StoredSession {
        val found = sessions.find(boardId, sessionId)
        limit(perUser, perShare, who, found?.id ?: Uuid.NIL)
        return found ?: throw notFound(sessionId)
    }

    /** [limited] with the limit of [operation]: moderator operations per user, the inputs of the seats per user and session. */
    suspend fun limited(operation: SessionOperation, who: Principal, boardId: Uuid, sessionId: Uuid): StoredSession = when (operation) {
        SessionOperation.JOIN_OR_LEAVE -> limited(seatChanges, shareSeatChanges, who, boardId, sessionId)
        SessionOperation.PLACE -> limited(placements, sharePlacements, who, boardId, sessionId)
        SessionOperation.ESTIMATE -> limited(estimates, shareEstimates, who, boardId, sessionId)
        SessionOperation.MODERATE -> {
            take(moderatorOps, who.id.toString())
            find(boardId, sessionId)
        }
    }

    /** The rate of a caller in a scope (a session or a board); a guest is counted by share as well (E17). */
    fun limit(perUser: WindowRateLimiter, perShare: WindowRateLimiter, who: Principal, scope: Uuid) {
        take(perUser, "${who.id}|$scope")
        if (who is Principal.Guest) take(perShare, "${who.shareId}|$scope")
    }

    fun take(limiter: WindowRateLimiter, key: String) {
        try {
            limiter.take(key)
        } catch (e: RateLimitedException) {
            metrics.refused(REASON_RATE)
            throw e
        }
    }

    fun notFound(sessionId: Uuid) = DomainException(ErrorCode.PLANNING_SESSION_NOT_FOUND, mapOf("sessionId" to sessionId.toString()))

    fun wrongState(session: StoredSession) = DomainException(
        ErrorCode.PLANNING_SESSION_WRONG_STATE,
        mapOf("sessionId" to session.id.toString(), "state" to session.state.name, "round" to session.round.toString()),
    )

    fun modeLabel(session: StoredSession): String = session.mode.name.lowercase()

    fun markThreshold(session: StoredSession): Int = session.settings.markThreshold ?: SessionRules.MARK_DEFAULT

    // --- transitions ----------------------------------------------------------------------------------------------------------

    private suspend fun dropMagic(
        session: StoredSession,
        all: List<StoredSeat>,
        gone: List<StoredSeat>,
        cards: List<StoredItem>,
    ): List<StoredItem> {
        val goneIds = gone.map { it.id }.toSet()
        val slots = gone.mapNotNull { it.slot }.toSet()
        val byItem = moves.findBySession(session.id).groupBy { it.itemId }
        gone.forEach { moves.deleteBySeat(session.id, it.id) }
        return cards.mapNotNull { card ->
            val cardMoves = byItem[card.id].orEmpty()
            val dealt = Ring.holder(card.position, 0, Ring.size(all)) in slots
            if (!dealt && cardMoves.none { it.seatId in goneIds }) return@mapNotNull null
            // where the card was before any move; a card dealt to a removed seat was placed by it, so it has no column of its own
            val placed = if (dealt) null else cardMoves.first().fromValue
            val left = rechain(cardMoves.filter { it.seatId !in goneIds }, placed)
            val after = card.copy(column = left.lastOrNull()?.toValue ?: placed, moveCount = left.size, touched = true)
            after.copy(marked = MagicMarks.marked(after, left, markThreshold(session)))
        }
    }

    /**
     * The moves left on a card after a removal, chained again (B2): the first starts where the card was placed ([placed], null for a card
     * dealt to the removed seat), every further one where the previous left it - so the trail never shows a column only the removed
     * seat chose.
     */
    private suspend fun rechain(left: List<StoredMove>, placed: String?): List<StoredMove> {
        var from = placed
        return left.sortedBy { it.seq }.map { move ->
            val chained = move.copy(fromValue = from)
            if (chained != move) moves.update(chained)
            from = move.toValue
            chained
        }
    }

    private suspend fun dropRotation(session: StoredSession, gone: List<StoredSeat>, cards: List<StoredItem>): List<StoredItem> {
        val goneIds = gone.map { it.id }.toSet()
        val entered = entries.findBySession(session.id).filter { it.seatId in goneIds }.map { it.itemId }.toSet()
        gone.forEach { entries.deleteBySeat(session.id, it.id) }
        return cards.filter { it.id in entered }.map { it.copy(touched = true) }
    }

    /** MOVING starts (or a seat was removed): the marks of the Magic cards from their columns and moves. */
    private suspend fun remark(session: StoredSession, cards: List<StoredItem>) {
        if (session.mode != EstimationMode.MAGIC) return
        val byItem = moves.findBySession(session.id).groupBy { it.itemId }
        items.updateAll(cards.map { it.copy(marked = MagicMarks.marked(it, byItem[it.id].orEmpty(), markThreshold(session))) })
    }

    /** REVIEW starts: seats of revoked links leave as in the running phase (safety net), the marks freeze, the mapping goes (E5). */
    private suspend fun enterReview(running: StoredSession, revoked: Set<Uuid>) {
        val gone = seats.findBySession(running.id).filter { !it.removed && it.shareId != null && it.shareId in revoked }
        dropSeats(running, gone)
        val magic = running.mode == EstimationMode.MAGIC
        if (magic) {
            remark(running, items.findBySession(running.id))
            moves.unlink(running.id)
        }
        if (running.anonymous) entries.unlink(running.id, reasons = false)
        if (running.anonymous || magic) seats.clearSlots(running.id)
    }

    companion object {
        const val SESSION = "session"
        const val REASON_RATE = "rate_limit"
    }
}
