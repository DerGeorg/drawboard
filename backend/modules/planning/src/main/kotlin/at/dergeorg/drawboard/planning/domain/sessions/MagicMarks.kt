package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove

/**
 * Which Magic cards are discussed in the review (E16, contract `EstimationItem.marked`): a card is marked when it has no column, sits
 * in the parking column `?`, was touched by a seat removed for a revoked link (E11), or was moved at least `markThreshold` times in
 * MOVING - each seat counting at most [COUNTED_PER_SEAT] moves of a card, so one seat can never mark a card alone (threshold >= 3).
 * Kept up to date in MOVING, frozen when REVIEW starts.
 */
internal object MagicMarks {

    const val PARKING = "?"
    const val COFFEE = "coffee"
    const val COUNTED_PER_SEAT = 2

    /** The columns of a Magic board: the deck without `coffee`, in deck order. */
    fun columns(deck: Deck): List<String> = deck.values.filter { it != COFFEE }

    /** The moves of one card as they count for the mark. */
    fun weight(moves: List<StoredMove>): Int = moves.groupBy { it.seatId }.values.sumOf { minOf(it.size, COUNTED_PER_SEAT) }

    fun marked(item: StoredItem, moves: List<StoredMove>, threshold: Int): Boolean =
        item.touched || item.column == null || item.column == PARKING || weight(moves) >= threshold

    /**
     * The columns a card went through, oldest first: where it was placed (the `from` of the first move), then one value per move - values
     * only, never who (E4). The moves are chained (each `from` is the previous `to`), also after a revocation removed some (B2).
     */
    fun trail(item: StoredItem, moves: List<StoredMove>): List<String> {
        val ordered = moves.sortedBy { it.seq }
        if (ordered.isEmpty()) return listOfNotNull(item.column)
        return listOfNotNull(ordered.first().fromValue) + ordered.map { it.toValue }
    }
}
