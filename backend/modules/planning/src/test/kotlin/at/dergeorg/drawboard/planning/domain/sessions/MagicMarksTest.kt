package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class MagicMarksTest {

    private val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.MOVING)
    private val a = aSeat(session, Principal.Member(Uuid.generateV7(), "A"), slot = 0)
    private val b = aSeat(session, Principal.Member(Uuid.generateV7(), "B"), slot = 1)

    @Test
    fun `when one seat moves a card back and forth then it counts twice at most and cannot mark it alone`() {
        val card = anItem(session, 0, column = "5")
        val moves = List(5) { aMove(card, a, "3", "5") }

        assertEquals(2, MagicMarks.weight(moves), "two of five count")
        assertFalse(MagicMarks.marked(card, moves, threshold = 3), "not marked by one seat")
    }

    @Test
    fun `when two seats move a card often enough then it is marked`() {
        val card = anItem(session, 0, column = "5")

        assertTrue(
            MagicMarks.marked(card, listOf(aMove(card, a, "3", "5"), aMove(card, a, "5", "3"), aMove(card, b, "3", "5")), 3),
            "2 + 1",
        )
    }

    @Test
    fun `when a card has no column, sits in the parking column or was touched by a removed seat then it is marked`() {
        assertTrue(MagicMarks.marked(anItem(session, 0, column = null), emptyList(), 3), "no column")
        assertTrue(MagicMarks.marked(anItem(session, 0, column = "?"), emptyList(), 3), "parking")
        assertTrue(MagicMarks.marked(anItem(session, 0, column = "5").copy(touched = true), emptyList(), 3), "touched")
        assertFalse(MagicMarks.marked(anItem(session, 0, column = "5"), emptyList(), 3), "an ordinary card")
    }

    @Test
    fun `when the trail of a card is asked then it is the placed column and one value per move, oldest first, values only`() {
        val card = anItem(session, 0, column = "8")
        val moves = listOf(aMove(card, b, "5", "8", T0 + 2.seconds, seq = 2), aMove(card, a, "3", "5", T0 + 1.seconds, seq = 1))

        assertEquals(listOf("3", "5", "8"), MagicMarks.trail(card, moves), "placed in 3, then 5, then 8")
        assertEquals(listOf("8"), MagicMarks.trail(card, emptyList()), "never moved")
        assertEquals(emptyList(), MagicMarks.trail(anItem(session, 1), emptyList()), "never placed")
    }

    @Test
    fun `when the columns of a deck are asked then coffee is not one of them`() {
        assertEquals(listOf("0", "1", "2", "3", "5", "8", "13", "21", "?"), MagicMarks.columns(session.deck), "fibonacci without coffee")
    }
}
