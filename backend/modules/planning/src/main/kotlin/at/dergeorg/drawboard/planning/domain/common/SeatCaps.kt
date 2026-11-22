package at.dergeorg.drawboard.planning.domain.common

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import kotlin.uuid.Uuid

/** One taken seat: whether a guest sits there and through which link. */
internal data class Seat(val guest: Boolean, val shareId: Uuid?)

/**
 * The caps on the seats of one round or session: [total] seats, of which at most [guests] for guests and [perShare] for the guests of
 * one link. [hit] names the limit a newcomer runs into, in the order guests-per-link, guests, total.
 */
internal class SeatCaps(val total: Int, val guests: Int, val perShare: Int) {

    /** The limit [who] hits when taking one more seat next to [taken], or null if there is room. */
    fun hit(who: Principal, taken: List<Seat>): Int? {
        if (who is Principal.Guest) {
            if (taken.count { it.shareId == who.shareId } >= perShare) return perShare
            if (taken.count { it.guest } >= guests) return guests
        }
        return if (taken.size >= total) total else null
    }
}
