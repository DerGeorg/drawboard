package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The rules of Magic Estimation that [at.dergeorg.drawboard.planning.domain.EstimationPlayService] applies (E13, E16, contract
 * `placeEstimationItem` and `decideEstimationItem`):
 *
 * * a column is a deck value other than `coffee`; `null` takes an own card out of its column and exists only in PLACING;
 * * in MOVING a move by the same seat of the same card within [MERGE_WINDOW] replaces its previous move, as long as nobody moved the
 *   card in between (back to where it came from removes it), so dragging a card around counts once;
 * * per seat at most [PER_CARD] moves of one card and [PER_ITEM] x the number of cards in total, at most `maxMovesPerSession` in the
 *   session (409 `PLANNING_MOVE_LIMIT_REACHED`);
 * * a decision is any column; it is `overridden` only for an unmarked card and a value other than its column.
 */
internal object MagicRules {

    const val PER_CARD = 5
    const val PER_ITEM = 3
    val MERGE_WINDOW: Duration = 10.seconds

    /** Whether [value] may go into a column in the session's current phase. */
    fun validValue(session: StoredSession, value: String?): Boolean =
        if (value == null) session.state == SessionState.PLACING else value in MagicMarks.columns(session.deck)

    /** The previous move a new one by [seatId] replaces: the card's last move, by the same seat, less than 10 s ago. */
    fun mergeTarget(cardMoves: List<StoredMove>, seatId: Uuid, now: Instant): StoredMove? {
        val last = cardMoves.maxByOrNull { it.seq } ?: return null
        val at = last.at ?: return null
        return last.takeIf { it.seatId == seatId && now - at < MERGE_WINDOW }
    }

    /** The limit a new move of [seatId] would exceed, or null if there is room. */
    fun limitHit(cardMoves: List<StoredMove>, seatId: Uuid, seatMoves: Int, sessionMoves: Int, items: Int, backstop: Int): Int? = when {
        cardMoves.count { it.seatId == seatId } >= PER_CARD -> PER_CARD
        seatMoves >= PER_ITEM * items -> PER_ITEM * items
        sessionMoves >= backstop -> backstop
        else -> null
    }

    /** Whether a decision of [value] is allowed for [item] - null if not - and whether it is overridden (E13). */
    fun decision(session: StoredSession, item: StoredItem, value: String): Boolean? {
        if (value !in MagicMarks.columns(session.deck)) return null
        return !item.marked && value != item.column
    }
}
