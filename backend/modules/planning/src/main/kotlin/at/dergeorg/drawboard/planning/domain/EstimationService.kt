package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.domain.common.Seat
import at.dergeorg.drawboard.planning.domain.common.SeatCaps
import at.dergeorg.drawboard.planning.domain.rounds.RoundRules
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.SessionClock
import at.dergeorg.drawboard.planning.domain.sessions.SessionKeeper
import at.dergeorg.drawboard.planning.domain.sessions.SessionRules
import at.dergeorg.drawboard.planning.domain.sessions.SessionViews
import at.dergeorg.drawboard.planning.domain.sessions.Settlement
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCreated
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionFinished
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionHeader
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionStarted
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSummary
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import at.dergeorg.drawboard.planning.domain.sessions.provides.AdvanceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.GetSessionQuery
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewSessionCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionAnswer
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionOperation
import at.dergeorg.drawboard.planning.domain.sessions.provides.StartCommand
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements the life of the estimation sessions (3.15, Fable E1-E24, contract review C1-C3): create, list, get, the lobby, start,
 * advance, finish, cancel, the revocation of guest links, the erasure of purged boards and the retention purge. The inputs of the
 * seats and the decisions are [EstimationPlayService]. Shared machinery (locks, clock, E9, the view mapper): [SessionKeeper].
 *
 * What raises `version` (the ETag of the polls): join and leave, start, every phase or round change, finish, cancel, removed seats of a
 * revoked link - and, in the play service, a flipped `done`, a Magic move, a decision. Nothing in a log: values, reasons, titles and
 * names never leave the module except in the views (E12, E23).
 */
@Service
@Suppress("TooManyFunctions")
internal class EstimationService(private val keeper: SessionKeeper) : EstimationUseCase {

    private val limits = keeper.limits
    private val seatCaps = SeatCaps(limits.maxSeats, limits.maxGuests, limits.maxGuestsPerShare)

    @WithSpan
    override suspend fun create(command: NewSessionCommand): SessionView {
        keeper.take(keeper.creates, command.moderator.id.toString())
        val violations = mutableListOf<InvalidField>()
        val title = SessionRules.line(command.title, "title", SessionRules.TITLE_MAX, violations)
        val cards = SessionRules.items(command.items, violations)
        val settings = SessionRules.settings(command.mode, command.settings, violations)
        if (violations.isNotEmpty()) throw ValidationFailedException(violations)
        val deck = RoundRules.deck(command.deck)
        return keeper.boardLocks.withLock(command.boardId) {
            // idle sessions do not block a new one: settled first (board lock -> session lock, the one allowed order, E15)
            keeper.sessions.findNewest(command.boardId, SessionState.ACTIVE, limits.maxClosedSessions)
                .filter { SessionClock.due(it, keeper.clock.now()) }
                .forEach { keeper.settled(command.boardId, it.id) }
            keeper.transactions.required {
                if (keeper.sessions.count(command.boardId, SessionState.ACTIVE) >= limits.maxActiveSessions) {
                    keeper.metrics.refused("session_limit")
                    throw DomainException(ErrorCode.PLANNING_SESSION_LIMIT_REACHED, mapOf("limit" to limits.maxActiveSessions.toString()))
                }
                pruneClosed(command.boardId)
                val now = keeper.clock.now()
                val session = StoredSession(
                    id = Uuid.generateV7(), boardId = command.boardId, mode = command.mode, title = checkNotNull(title), deck = deck,
                    anonymous = command.anonymous ?: true, settings = settings, state = SessionState.LOBBY, round = 0, phaseEndsAt = null,
                    moderatorId = command.moderator.id, moderatorName = command.moderator.displayName, itemCount = cards.size,
                    createdAt = now, startedAt = null, closedAt = null, lastActivityAt = now, reducedAt = null, version = FIRST_VERSION,
                )
                keeper.sessions.insert(session)
                keeper.items.insertAll(
                    cards.mapIndexed { position, card ->
                        StoredItem(
                            id = Uuid.generateV7(), sessionId = session.id, position = position, ref = card.ref, title = card.title,
                            column = null, moveCount = 0, marked = false, touched = false, decision = null, overridden = false,
                        )
                    },
                )
                keeper.record(
                    session, AuditAction.CREATED, "created",
                    SessionCreated(session.boardId.toString(), session.mode.name, cards.size, deck.kind.name),
                )
                keeper.metrics.session("created", keeper.modeLabel(session))
                keeper.view(session, Viewer(command.moderator, editor = true, owner = false))
            }
        }
    }

    @WithSpan
    override suspend fun list(@SpanAttribute("board.id") boardId: Uuid, states: Set<SessionState>, viewer: Viewer): List<SessionSummary> {
        keeper.limit(keeper.lists, keeper.shareLists, viewer.principal, boardId)
        // what the clock says first, for the active sessions in either list: an idle one belongs to the closed ones now
        keeper.sessions.findNewest(boardId, SessionState.ACTIVE, limits.maxClosedSessions)
            .filter { SessionClock.due(it, keeper.clock.now()) }
            .forEach { keeper.settled(boardId, it.id) }
        val found = keeper.sessions.findNewest(boardId, states, limits.maxClosedSessions)
        val byId = keeper.seats.findBySessions(found.map { it.id }).groupBy { it.sessionId }
        return found.mapNotNull { SessionViews.summary(it, byId[it.id].orEmpty(), viewer) }
    }

    @WithSpan
    override suspend fun get(query: GetSessionQuery): SessionAnswer {
        keeper.limited(keeper.gets, keeper.shareGets, query.viewer.principal, query.boardId, query.sessionId)
        val session = keeper.settled(query.boardId, query.sessionId)
        keeper.requireVisible(session, query.viewer.principal)
        // after the clock and E9 (C2 SHOULD): a 304 never hides a due transition and never answers a caller who would get 404
        if (query.unchanged(session.version)) return SessionAnswer.NotModified(session.version)
        return SessionAnswer.Found(keeper.view(session, query.viewer))
    }

    @WithSpan
    override suspend fun header(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        principal: Principal,
        operation: SessionOperation,
        itemId: Uuid?,
    ): SessionHeader {
        val stored = keeper.limited(operation, principal, boardId, sessionId)
        // what the clock says now, without writing it: the operation that follows settles under the lock
        val session = SessionClock.settle(stored, keeper.clock.now()).session
        keeper.requireVisible(session, principal)
        if (itemId != null) keeper.item(session, itemId)
        return SessionHeader(session.moderatorId, session.state)
    }

    @WithSpan
    override suspend fun join(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        principal: Principal,
    ) {
        keeper.sessionLocks.withLock(sessionId) {
            keeper.settleLocked(boardId, sessionId)
            keeper.transactions.required {
                val session = keeper.find(boardId, sessionId)
                keeper.requireVisible(session, principal)
                if (session.state != SessionState.LOBBY) throw keeper.wrongState(session)
                val current = keeper.seats.findBySession(session.id)
                if (current.none { it.isPrincipal(principal) }) {
                    seatCaps.hit(principal, current.map { Seat(it.guest, it.shareId) })?.let { limit ->
                        keeper.metrics.refused("session_full")
                        throw DomainException(
                            ErrorCode.PLANNING_SESSION_FULL, mapOf("sessionId" to session.id.toString(), "limit" to limit.toString()),
                        )
                    }
                    val inserted = keeper.seats.insert(
                        StoredSeat(
                            id = Uuid.random(), sessionId = session.id,
                            kind = if (principal is Principal.Guest) ParticipantKind.GUEST else ParticipantKind.USER,
                            principalId = principal.id, shareId = (principal as? Principal.Guest)?.shareId,
                            displayName = principal.displayName, position = (current.maxOfOrNull { it.position } ?: 0) + 1,
                            joinedAt = keeper.clock.now(), seated = true, slot = null, removed = false,
                        ),
                    )
                    if (!inserted) throw DomainException(ErrorCode.CONFLICT) // the same caller joined concurrently
                    keeper.raise(session)
                }
            }
        }
    }

    @WithSpan
    override suspend fun leave(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        principal: Principal,
    ) {
        keeper.sessionLocks.withLock(sessionId) {
            keeper.settleLocked(boardId, sessionId)
            keeper.transactions.required {
                val session = keeper.find(boardId, sessionId)
                keeper.requireVisible(session, principal)
                if (session.state != SessionState.LOBBY) throw keeper.wrongState(session)
                val own = keeper.own(session.id, principal)
                if (own != null) {
                    keeper.seats.deleteAll(listOf(own.id))
                    keeper.raise(session)
                }
            }
        }
    }

    @WithSpan
    override suspend fun start(command: StartCommand): SessionView {
        return keeper.sessionLocks.withLock(command.sessionId) {
            val before = keeper.settleLocked(command.boardId, command.sessionId)
            if (before.state != SessionState.LOBBY) throw keeper.wrongState(before)
            val revoked = keeper.revokedShares(before.id)
            keeper.transactions.required {
                val session = keeper.find(command.boardId, command.sessionId)
                if (session.state != SessionState.LOBBY) throw keeper.wrongState(session)
                val all = keeper.seats.findBySession(session.id)
                // seats of revoked links are dropped first (E11)
                val gone = all.filter { it.shareId != null && it.shareId in revoked }
                keeper.dropSeats(session, gone)
                val picked = pick(session, all, gone, command.seatIds)
                val slots = picked.shuffled(keeper.random).withIndex().associate { (slot, seat) -> seat.id to slot }
                keeper.seats.updateAll(
                    (all - gone.toSet()).map { seat -> seat.copy(seated = seat.id in slots, slot = slots[seat.id]) },
                )
                val started = SessionClock.started(session, keeper.clock.now())
                keeper.sessions.update(session, started)
                keeper.record(
                    started, AuditAction.STARTED, "started",
                    SessionStarted(started.boardId.toString(), picked.count { !it.guest }, picked.count { it.guest }),
                )
                keeper.metrics.session("started", keeper.modeLabel(started))
                keeper.view(started, command.viewer)
            }
        }
    }

    @WithSpan
    override suspend fun advance(command: AdvanceCommand): SessionView {
        return keeper.sessionLocks.withLock(command.sessionId) {
            val before = keeper.settleLocked(command.boardId, command.sessionId)
            expect(before, command)
            val next = SessionClock.next(before, keeper.clock.now())
            val revoked = if (next.state == SessionState.REVIEW) keeper.revokedShares(before.id) else emptySet()
            keeper.transactions.required {
                val session = keeper.find(command.boardId, command.sessionId)
                expect(session, command)
                val advanced = SessionClock.next(session, keeper.clock.now())
                keeper.apply(session, Settlement(advanced, listOf(advanced.state), idleCancelled = false), revoked)
                keeper.view(advanced, command.viewer)
            }
        }
    }

    @WithSpan
    override suspend fun finish(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        viewer: Viewer,
    ): SessionView {
        return keeper.sessionLocks.withLock(sessionId) {
            keeper.settleLocked(boardId, sessionId)
            keeper.transactions.required {
                val session = keeper.find(boardId, sessionId)
                if (session.state != SessionState.REVIEW) throw keeper.wrongState(session)
                val now = keeper.clock.now()
                val done = session.copy(state = SessionState.DONE, closedAt = now, lastActivityAt = now, version = session.version + 1)
                keeper.sessions.update(session, done)
                val cards = keeper.items.findBySession(session.id)
                keeper.record(
                    done, AuditAction.COMPLETED, "finished",
                    SessionFinished(
                        boardId = done.boardId.toString(),
                        decisions = cards.count { it.decision != null },
                        overridden = cards.count { it.decision != null && it.overridden },
                    ),
                )
                keeper.metrics.session("finished", keeper.modeLabel(done))
                keeper.view(done, viewer)
            }
        }
    }

    @WithSpan
    override suspend fun cancel(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        viewer: Viewer,
    ): SessionView {
        return keeper.sessionLocks.withLock(sessionId) {
            keeper.settleLocked(boardId, sessionId)
            keeper.transactions.required {
                val session = keeper.find(boardId, sessionId)
                if (!session.state.active) throw keeper.wrongState(session)
                val cancelled = SessionClock.cancelled(session, keeper.clock.now())
                keeper.apply(session, Settlement(cancelled, listOf(SessionState.CANCELLED), idleCancelled = false), emptySet())
                keeper.view(cancelled, viewer)
            }
        }
    }

    @WithSpan
    override suspend fun removeGuestsOfShare(@SpanAttribute("share.id") shareId: Uuid) {
        keeper.seats.findByShare(shareId).filter { !it.removed }.map { it.sessionId }.distinct().forEach { sessionId ->
            val boardId = keeper.sessions.findAllById(listOf(sessionId)).singleOrNull()?.boardId ?: return@forEach
            keeper.sessionLocks.withLock(sessionId) {
                keeper.settleLocked(boardId, sessionId)
                keeper.transactions.required {
                    val session = keeper.find(boardId, sessionId)
                    val ours = keeper.seats.findBySession(sessionId).filter { it.shareId == shareId && !it.removed }
                    if (keeper.dropSeats(session, ours)) keeper.advanceIfDone(keeper.raise(session))
                }
            }
        }
    }

    @WithSpan
    override suspend fun deleteBoardData(boardIds: Collection<Uuid>) {
        if (boardIds.isEmpty()) return
        keeper.transactions.required { keeper.deleteSessions(keeper.sessions.idsOfBoards(boardIds)) }
    }

    @WithSpan
    override suspend fun reduceExpired(now: Instant): Int {
        var reduced = 0
        do {
            val batch = keeper.sessions.findExpired(now - SessionViews.RETENTION, PURGE_BATCH)
            batch.forEach { found ->
                keeper.sessionLocks.withLock(found.id) {
                    keeper.transactions.required {
                        val session = keeper.find(found.boardId, found.id)
                        keeper.entries.unlink(session.id, reasons = true)
                        keeper.moves.deleteBySessions(listOf(session.id))
                        keeper.seats.clearSlots(session.id)
                        keeper.sessions.update(session, session.copy(reducedAt = keeper.clock.now()))
                    }
                }
                reduced++
            }
        } while (batch.size == PURGE_BATCH)
        return reduced
    }

    /** The seats that take part (C3, E7): known seats of this session, at least two, not more than cards, not fewer than rounds. */
    private fun pick(session: StoredSession, all: List<StoredSeat>, gone: List<StoredSeat>, seatIds: Set<Uuid>): List<StoredSeat> {
        val known = all.map { it.id }.toSet()
        val goneIds = gone.map { it.id }.toSet()
        val picked = all.filter { it.id in seatIds && it.id !in goneIds }
        val problem = when {
            seatIds.any { it !in known } -> "every seat must be a listed seat of this session"
            picked.size < 2 -> "at least 2 seats take part"
            picked.size > limits.maxSeats -> "at most ${limits.maxSeats} seats take part"
            picked.size > session.itemCount -> "not more seats than cards (${session.itemCount})"
            session.mode == EstimationMode.ROTATION && checkNotNull(session.settings.rounds) > picked.size ->
                "at least as many seats as rounds (${session.settings.rounds})"
            else -> null
        }
        if (problem != null) throw ValidationFailedException(listOf(InvalidField("seatIds", "Size", problem)))
        return picked
    }

    private fun expect(session: StoredSession, command: AdvanceCommand) {
        if (!session.state.running || session.state != command.state || session.round != command.round) throw keeper.wrongState(session)
    }

    /** Keeps at most `maxClosedSessions` closed sessions of the board: the oldest CANCELLED go first, then the oldest DONE. */
    private suspend fun pruneClosed(boardId: Uuid) {
        val cancelled = keeper.sessions.count(boardId, listOf(SessionState.CANCELLED))
        val done = keeper.sessions.count(boardId, listOf(SessionState.DONE))
        val surplus = cancelled + done - limits.maxClosedSessions
        if (surplus <= 0) return
        val firstGo = minOf(surplus, cancelled)
        val doomed = buildList {
            if (firstGo > 0) addAll(keeper.sessions.findOldest(boardId, SessionState.CANCELLED, firstGo))
            if (surplus > firstGo) addAll(keeper.sessions.findOldest(boardId, SessionState.DONE, surplus - firstGo))
        }
        keeper.deleteSessions(doomed.map { it.id })
    }

    private companion object {
        const val FIRST_VERSION = 1L
        const val PURGE_BATCH = 100
    }
}
