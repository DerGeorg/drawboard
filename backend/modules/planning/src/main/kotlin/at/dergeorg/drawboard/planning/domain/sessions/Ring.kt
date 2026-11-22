package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import kotlin.uuid.Uuid

/**
 * Who holds which card: the seats taking part sit in a ring of secret slots 0..P-1 (E2); card i is held in round r by slot
 * (i + r) mod P. Magic deals with r = 0. Rounds are at most P (E7) and every seat holds at least one card (C3), so nobody holds a card
 * twice. Never published - only `mine` for the caller's own cards leaves the server.
 */
internal object Ring {

    /** The slot that holds the card at [position] in [round] of a ring of [size] slots. */
    fun holder(position: Int, round: Int, size: Int): Int {
        require(size >= 1 && position >= 0 && round >= 0) { "a ring has slots, cards and rounds count from 0" }
        return (position + round) % size
    }

    /** The number of slots: every seat that was picked at the start, removed ones included (their cards stay in the ring). */
    fun size(seats: List<StoredSeat>): Int = seats.count { it.slot != null }

    /** Whether [seat] works on [item] now: Magic PLACING (dealt) or Rotation ROTATING (held this round); false everywhere else. */
    fun holds(session: StoredSession, seats: List<StoredSeat>, seat: StoredSeat?, item: StoredItem): Boolean {
        if (seat == null || !seat.inRing) return false
        val slot = checkNotNull(seat.slot)
        val round = when (session.state) {
            SessionState.PLACING -> 0
            SessionState.ROTATING -> session.round
            else -> return false
        }
        return holder(item.position, round, size(seats)) == slot
    }
}

/**
 * The only progress published before REVIEW (E3): per seat, never per card. PLACING - every card dealt to the seat has a column;
 * ROTATING - every card the seat holds in this round has an entry of this round. False in every other state and for seats that do
 * not take part or were removed.
 */
internal object Progress {

    fun done(
        session: StoredSession,
        seats: List<StoredSeat>,
        seat: StoredSeat,
        items: List<StoredItem>,
        entries: List<StoredEntry>,
    ): Boolean {
        if (!session.state.running || !seat.inRing) return false
        val own = items.filter { Ring.holds(session, seats, seat, it) }
        return when (session.state) {
            SessionState.PLACING -> own.all { it.column != null }
            SessionState.ROTATING -> {
                val entered = entries.filter { it.round == session.round }.map { it.itemId }.toSet()
                own.all { it.id in entered }
            }
            else -> false
        }
    }

    /** The seats that are done now, by id. */
    fun doneSeats(session: StoredSession, seats: List<StoredSeat>, items: List<StoredItem>, entries: List<StoredEntry>): Set<Uuid> =
        seats.filter { done(session, seats, it, items, entries) }.map { it.id }.toSet()
}
