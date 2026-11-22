package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.domain.sessions.MagicMarks
import at.dergeorg.drawboard.planning.domain.sessions.MagicRules
import at.dergeorg.drawboard.planning.domain.sessions.Progress
import at.dergeorg.drawboard.planning.domain.sessions.Ring
import at.dergeorg.drawboard.planning.domain.sessions.RotationInput
import at.dergeorg.drawboard.planning.domain.sessions.RotationRules
import at.dergeorg.drawboard.planning.domain.sessions.SessionKeeper
import at.dergeorg.drawboard.planning.domain.sessions.SessionRules
import at.dergeorg.drawboard.planning.domain.sessions.SessionViews
import at.dergeorg.drawboard.planning.domain.sessions.model.DecisionOverridden
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.provides.DecideCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimateCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationPlayUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.PlaceCommand
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the inputs of an estimation session: Magic placements and moves, Rotation estimates, the moderator's decisions. Each
 * keeps the order of refusals C2 - session and E9 (404), card (404), seat (403), state and expected round (409), card held (409), value
 * (400), reason (400), move limits (409) - so a seat that does not hold a card learns nothing about it: it never gets
 * `PLANNING_REASON_REQUIRED` and never `currentValue` (E4). The value is never echoed, logged or traced (E12).
 *
 * The rates (E17) are taken by [at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase.header], which `api` asks
 * first.
 *
 * `version` rises only when a seat's `done` flips (E3), on every Magic move in MOVING and on a decision - not on a placement in PLACING
 * or an entry that flips nothing, not when an own entry is changed.
 */
@Service
internal class EstimationPlayService(private val keeper: SessionKeeper) : EstimationPlayUseCase {

    @WithSpan
    override suspend fun place(command: PlaceCommand) {
        keeper.sessionLocks.withLock(command.sessionId) {
            keeper.settleLocked(command.boardId, command.sessionId)
            keeper.transactions.required {
                val session = keeper.find(command.boardId, command.sessionId)
                keeper.requireVisible(session, command.principal)
                val item = keeper.item(session, command.itemId)
                val seat = keeper.seated(session, command.principal)
                val phase = session.state == SessionState.PLACING || session.state == SessionState.MOVING
                val expected = command.state == null || command.state == session.state
                if (session.mode != EstimationMode.MAGIC || !phase || !expected) {
                    throw keeper.wrongState(session)
                }
                if (session.state == SessionState.PLACING) placeOwn(session, seat, item, command.value) else move(
                    session,
                    seat,
                    item,
                    command.value,
                )
            }
        }
    }

    @WithSpan
    override suspend fun estimate(command: EstimateCommand): EntryView {
        // the form of the text only: the same for every session, so it may come first (C2); whether a reason is NEEDED comes last
        val reason = command.reason?.let { SessionRules.line(it, "reason", SessionRules.REASON_MAX) }
        return keeper.sessionLocks.withLock(command.sessionId) {
            keeper.settleLocked(command.boardId, command.sessionId)
            keeper.transactions.required {
                val session = keeper.find(command.boardId, command.sessionId)
                keeper.requireVisible(session, command.principal)
                val item = keeper.item(session, command.itemId)
                val seat = keeper.seated(session, command.principal)
                val rotating = session.mode == EstimationMode.ROTATION && session.state == SessionState.ROTATING
                if (!rotating || (command.round != null && command.round != session.round)) throw keeper.wrongState(session)
                val seats = keeper.seats.findBySession(session.id)
                // the same answer whether another seat holds the card or the caller holds it in another round (E2)
                if (!Ring.holds(session, seats, seat, item)) throw notHeld(session, item)
                if (command.value !in session.deck.values) throw valueInvalid(session, item)
                val entries = keeper.entries.findBySession(session.id)
                val current = SessionViews.currentValue(entries, item, session.round)
                when (val input = RotationRules.entry(current, command.value, reason)) {
                    RotationInput.ReasonRequired -> throw DomainException(ErrorCode.PLANNING_REASON_REQUIRED, ids(session, item))
                    is RotationInput.Entry -> {
                        store(session, seats, seat, item, entries, command.value, input)
                        keeper.metrics.input("estimate")
                        EntryView(command.value, input.reason, input.kept)
                    }
                }
            }
        }
    }

    @WithSpan
    override suspend fun decide(command: DecideCommand) {
        keeper.sessionLocks.withLock(command.sessionId) {
            keeper.settleLocked(command.boardId, command.sessionId)
            keeper.transactions.required {
                val session = keeper.find(command.boardId, command.sessionId)
                val item = keeper.item(session, command.itemId)
                if (session.state != SessionState.REVIEW) throw keeper.wrongState(session)
                val overridden = when (session.mode) {
                    EstimationMode.MAGIC -> MagicRules.decision(session, item, command.value)
                    EstimationMode.ROTATION ->
                        RotationRules.decision(
                            session,
                            keeper.entries.findBySession(session.id).filter { it.itemId == item.id },
                            command.value,
                        )
                } ?: throw DomainException(ErrorCode.PLANNING_DECISION_INVALID, ids(session, item)) // the value is not echoed
                keeper.items.updateAll(listOf(item.copy(decision = command.value, overridden = overridden)))
                keeper.raise(session)
                if (overridden) {
                    keeper.record(
                        session, AuditAction.UPDATED, "decision-overridden",
                        DecisionOverridden(session.boardId.toString(), item.id.toString()),
                    )
                }
            }
        }
    }

    /** PLACING: the caller puts one of the cards dealt to them into a column, or takes it out; nobody else sees it (E4). */
    private suspend fun placeOwn(session: StoredSession, seat: StoredSeat, item: StoredItem, value: String?) {
        val seats = keeper.seats.findBySession(session.id)
        if (!Ring.holds(session, seats, seat, item)) throw notHeld(session, item)
        if (!MagicRules.validValue(session, value)) throw valueInvalid(session, item)
        if (value == item.column) {
            keeper.touch(session)
            return
        }
        val before = keeper.items.findBySession(session.id)
        val after = before.map { if (it.id == item.id) it.copy(column = value) else it }
        keeper.items.updateAll(listOf(item.copy(column = value)))
        flip(session, seats, seat, before, after, emptyList(), emptyList())
        keeper.metrics.input("placement")
    }

    /** MOVING: any seated seat moves any card to another column; recorded without being shown (E4), limited (E16). */
    private suspend fun move(session: StoredSession, seat: StoredSeat, item: StoredItem, value: String?) {
        if (!MagicRules.validValue(session, value)) throw valueInvalid(session, item)
        val target = checkNotNull(value)
        if (target == item.column) {
            keeper.touch(session)
            return
        }
        val now = keeper.clock.now()
        val cardMoves = keeper.moves.findByItem(item.id)
        val previous = MagicRules.mergeTarget(cardMoves, seat.id, now)
        when {
            previous != null && previous.fromValue == target -> keeper.moves.delete(previous.id)
            previous != null -> keeper.moves.update(previous.copy(toValue = target))
            else -> {
                MagicRules.limitHit(
                    cardMoves, seat.id, keeper.moves.countBySeat(session.id, seat.id), keeper.moves.countBySession(session.id),
                    session.itemCount, keeper.limits.maxMovesPerSession,
                )?.let { limit ->
                    keeper.metrics.refused("move_limit")
                    throw DomainException(
                        ErrorCode.PLANNING_MOVE_LIMIT_REACHED, mapOf("sessionId" to session.id.toString(), "limit" to limit.toString()),
                    )
                }
                keeper.moves.insert(
                    StoredMove(
                        id = Uuid.random(), sessionId = session.id, itemId = item.id, seatId = seat.id, fromValue = item.column,
                        toValue = target, at = now, seq = keeper.moves.nextSeq(session.id),
                    ),
                )
            }
        }
        val left = keeper.moves.findByItem(item.id)
        val moved = item.copy(column = target, moveCount = left.size)
        keeper.items.updateAll(listOf(moved.copy(marked = MagicMarks.marked(moved, left, keeper.markThreshold(session)))))
        keeper.raise(session)
        keeper.metrics.input("move")
    }

    /** Writes the caller's entry for the card in this round (a new one, or their own changed one). */
    @Suppress("LongParameterList")
    private suspend fun store(
        session: StoredSession,
        seats: List<StoredSeat>,
        seat: StoredSeat,
        item: StoredItem,
        entries: List<StoredEntry>,
        value: String,
        input: RotationInput.Entry,
    ) {
        val existing = entries.firstOrNull { it.itemId == item.id && it.round == session.round }
        val entry = existing?.copy(value = value, reason = input.reason, kept = input.kept)
            ?: StoredEntry(
                id = Uuid.random(), sessionId = session.id, itemId = item.id, seatId = seat.id, round = session.round, value = value,
                reason = input.reason, kept = input.kept, shuffle = keeper.random.nextLong(), createdAt = keeper.clock.now(),
            )
        if (existing == null) keeper.entries.insert(entry) else keeper.entries.update(entry)
        val after = entries.filter { it.id != entry.id } + entry
        val cards = keeper.items.findBySession(session.id)
        flip(session, seats, seat, cards, cards, entries, after)
    }

    /** Raises the version only when the seat's `done` flipped (E3), and ends a Rotation round when everyone is done; else only counts. */
    @Suppress("LongParameterList")
    private suspend fun flip(
        session: StoredSession,
        seats: List<StoredSeat>,
        seat: StoredSeat,
        itemsBefore: List<StoredItem>,
        itemsAfter: List<StoredItem>,
        entriesBefore: List<StoredEntry>,
        entriesAfter: List<StoredEntry>,
    ) {
        val before = Progress.done(session, seats, seat, itemsBefore, entriesBefore)
        val after = Progress.done(session, seats, seat, itemsAfter, entriesAfter)
        if (before == after) {
            keeper.touch(session)
        } else {
            keeper.advanceIfDone(keeper.raise(session))
        }
    }

    private fun ids(session: StoredSession, item: StoredItem) = mapOf("sessionId" to session.id.toString(), "itemId" to item.id.toString())

    private fun notHeld(session: StoredSession, item: StoredItem) = DomainException(ErrorCode.PLANNING_ITEM_NOT_HELD, ids(session, item))

    /** The value is not echoed: in PLACING and ROTATING it is the caller's secret. */
    private fun valueInvalid(session: StoredSession, item: StoredItem) = DomainException(
        ErrorCode.PLANNING_VALUE_INVALID,
        ids(session, item),
    )
}
