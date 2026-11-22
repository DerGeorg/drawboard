package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.common.ValueStats
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemResult
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import kotlin.uuid.Uuid

/**
 * The outcome of one card from REVIEW on (E5), computed from the entries and moves (nothing of it is stored). ROTATION: every entry in
 * the stored random order, never by round, without entry id, round or time, with names only when the session is not anonymous; mean,
 * median and distribution of the values; the candidates are the values entered. MAGIC: the trail of columns (values only, E4); the
 * candidates are the column of an unmarked card or every column of a marked one. [reduced] (30 days after DONE, E22): no single
 * value and no reason any more - the aggregates stay.
 */
internal object SessionResults {

    fun of(
        session: StoredSession,
        item: StoredItem,
        entries: List<StoredEntry>,
        moves: List<StoredMove>,
        seats: Map<Uuid, StoredSeat>,
        reduced: Boolean,
    ): ItemResult = when (session.mode) {
        EstimationMode.ROTATION -> {
            val own = entries.filter { it.itemId == item.id }.sortedWith(compareBy({ it.shuffle }, { it.id }))
            val values = own.map { it.value }
            val stats = ValueStats.of(session.deck, values)
            ItemResult(
                entries = if (reduced) emptyList() else own.map { entry(session, it, seats) },
                average = stats.average,
                median = stats.median,
                distribution = stats.distribution,
                candidates = session.deck.values.filter { it in values },
                moveTrail = emptyList(),
            )
        }
        EstimationMode.MAGIC -> ItemResult(
            entries = emptyList(),
            average = null,
            median = null,
            distribution = emptyList(),
            candidates = if (item.marked) MagicMarks.columns(session.deck) else listOfNotNull(item.column),
            moveTrail = if (reduced) emptyList() else MagicMarks.trail(item, moves.filter { it.itemId == item.id }),
        )
    }

    private fun entry(session: StoredSession, entry: StoredEntry, seats: Map<Uuid, StoredSeat>): EntryView {
        val seat = if (session.anonymous) null else entry.seatId?.let(seats::get)
        return EntryView(
            value = entry.value,
            reason = entry.reason,
            kept = entry.kept,
            displayName = seat?.displayName,
            guest = seat?.guest,
            userId = seat?.takeUnless { it.guest }?.principalId,
        )
    }
}
