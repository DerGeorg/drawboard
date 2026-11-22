package at.dergeorg.drawboard.planning.domain.common

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.uuid.Uuid

class SeatCapsTest {

    private val caps = SeatCaps(total = 5, guests = 3, perShare = 2)
    private val share = Uuid.generateV7()
    private val guest = Principal.Guest(Uuid.generateV7(), "G", share)
    private val member = Principal.Member(Uuid.generateV7(), "M")

    private fun seats(members: Int = 0, guests: Int = 0, share: Uuid = this.share) =
        List(members) { Seat(false, null) } + List(guests) { Seat(true, share) }

    @Test
    fun `when there is room then no limit is hit`() {
        assertNull(caps.hit(guest, seats(members = 1, guests = 1)), "room for the guest")
    }

    @Test
    fun `when the link has its guests then the per link limit is hit first`() {
        assertEquals(2, caps.hit(guest, seats(guests = 2)), "two guests of this link")
    }

    @Test
    fun `when guests of other links fill the guest cap then the guest limit is hit`() {
        assertEquals(3, caps.hit(guest, seats(guests = 3, share = Uuid.generateV7())), "three guests in all")
    }

    @Test
    fun `when all seats are taken then the total is hit, for a member too, and guest caps do not bind a member`() {
        assertEquals(5, caps.hit(member, seats(members = 5)), "full for a member")
        assertNull(caps.hit(member, seats(members = 1, guests = 3)), "a member is no guest")
    }
}
