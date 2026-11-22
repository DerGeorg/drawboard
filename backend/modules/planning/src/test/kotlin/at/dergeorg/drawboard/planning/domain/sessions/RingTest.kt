package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class RingTest {

    private fun member(name: String) = Principal.Member(Uuid.generateV7(), name)

    @Nested
    inner class Holder {

        @Test
        fun `when cards wander then card i is held by slot (i + r) mod P`() {
            assertEquals(listOf(0, 1, 2, 0, 1), (0..4).map { Ring.holder(it, 0, 3) }, "round 0 deals evenly")
            assertEquals(listOf(1, 2, 0, 1, 2), (0..4).map { Ring.holder(it, 1, 3) }, "round 1 moves every card one slot on")
        }

        @Test
        fun `when there are at most as many rounds as slots then nobody holds a card twice (E7)`() {
            val slots = 4
            (0 until 10).forEach { card ->
                val holders = (0 until slots).map { round -> Ring.holder(card, round, slots) }
                assertEquals(slots, holders.toSet().size, "card $card has a different holder in every round")
            }
        }

        @Test
        fun `when nobody else is asked then holds is only true for the caller's own cards in PLACING and ROTATING`() {
            val session = aSession(mode = EstimationMode.ROTATION, state = SessionState.ROTATING, round = 1)
            val a = aSeat(session, member("A"), slot = 0)
            val b = aSeat(session, member("B"), slot = 1)
            val watcher = aSeat(session, member("W"), slot = null, position = 3, seated = false)
            val cards = (0..3).map { anItem(session, it) }

            assertEquals(
                listOf(1, 3),
                cards.filter { Ring.holds(session, listOf(a, b, watcher), a, it) }.map { it.position },
                "A in round 1",
            )
            assertTrue(cards.none { Ring.holds(session, listOf(a, b, watcher), watcher, it) }, "a watcher holds nothing")
            assertTrue(
                cards.none { Ring.holds(session.copy(state = SessionState.REVIEW), listOf(a, b), a, it) },
                "nothing is held in REVIEW",
            )
            assertTrue(cards.none { Ring.holds(session, listOf(a, b), a.copy(removed = true), it) }, "a removed seat holds nothing")
        }
    }

    @Nested
    inner class Done {

        @Test
        fun `when a seat placed every card dealt to it then it is done, the other seat not yet`() {
            val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.PLACING)
            val a = aSeat(session, member("A"), slot = 0)
            val b = aSeat(session, member("B"), slot = 1)
            val cards = listOf(
                anItem(session, 0, column = "3"),
                anItem(session, 1),
                anItem(session, 2, column = "5"),
                anItem(session, 3, "8"),
            )

            assertEquals(setOf(a.id), Progress.doneSeats(session, listOf(a, b), cards, emptyList()), "A placed 0 and 2, B misses 1")
        }

        @Test
        fun `when a seat entered every card it holds in this round then it is done - entries of other rounds do not count`() {
            val session = aSession(state = SessionState.ROTATING, round = 1)
            val a = aSeat(session, member("A"), slot = 0)
            val b = aSeat(session, member("B"), slot = 1)
            val cards = (0..1).map { anItem(session, it) }
            // round 1: card 0 -> slot 1 (B), card 1 -> slot 0 (A)
            val entries = listOf(anEntry(cards[1], a, round = 1, value = "3"), anEntry(cards[0], a, round = 0, value = "5"))

            assertTrue(Progress.done(session, listOf(a, b), a, cards, entries), "A entered card 1 in round 1")
            assertFalse(Progress.done(session, listOf(a, b), b, cards, entries), "B has not entered card 0 in round 1")
        }

        @Test
        fun `when the session is not running then nobody is done`() {
            val session = aSession(state = SessionState.REVIEW)
            val a = aSeat(session, member("A"), slot = 0)

            assertFalse(Progress.done(session, listOf(a), a, listOf(anItem(session, 0)), emptyList()), "REVIEW")
        }
    }
}
