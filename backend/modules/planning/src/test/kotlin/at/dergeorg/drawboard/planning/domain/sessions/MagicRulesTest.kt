package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class MagicRulesTest {

    private val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.MOVING)
    private val a = aSeat(session, Principal.Member(Uuid.generateV7(), "A"), slot = 0)
    private val b = aSeat(session, Principal.Member(Uuid.generateV7(), "B"), slot = 1)

    @Test
    fun `when a value is checked then coffee is never a column and null only takes a card out in PLACING`() {
        assertTrue(MagicRules.validValue(session, "13"), "a column")
        assertFalse(MagicRules.validValue(session, "coffee"), "coffee")
        assertFalse(MagicRules.validValue(session, "4"), "not in the deck")
        assertFalse(MagicRules.validValue(session, null), "null in MOVING")
        assertTrue(MagicRules.validValue(session.copy(state = SessionState.PLACING), null), "null in PLACING")
    }

    @Test
    fun `when the same seat moves a card again within 10 seconds and nobody moved it in between then the moves merge`() {
        val card = anItem(session, 0)
        val last = aMove(card, a, "3", "5", T0, seq = 1)

        assertEquals(last, MagicRules.mergeTarget(listOf(last), a.id, T0 + 9.seconds), "within 10 s")
        assertNull(MagicRules.mergeTarget(listOf(last), a.id, T0 + 10.seconds), "10 s later it is a new move")
        assertNull(
            MagicRules.mergeTarget(listOf(last, aMove(card, b, "5", "8", T0 + 1.seconds, seq = 2)), a.id, T0 + 2.seconds),
            "B moved it since",
        )
        assertNull(MagicRules.mergeTarget(listOf(last), b.id, T0 + 1.seconds), "another seat")
    }

    @Test
    fun `when a seat has used its moves then the limit it hits is named - per card, per seat, per session (E16)`() {
        val card = anItem(session, 0)
        val five = List(5) { aMove(card, a, "3", "5") }

        assertEquals(5, MagicRules.limitHit(five, a.id, seatMoves = 5, sessionMoves = 5, items = 4, backstop = 5000), "5 per card")
        assertEquals(12, MagicRules.limitHit(emptyList(), a.id, seatMoves = 12, sessionMoves = 12, items = 4, backstop = 5000), "3 x items")
        assertEquals(20, MagicRules.limitHit(emptyList(), a.id, seatMoves = 0, sessionMoves = 20, items = 4, backstop = 20), "backstop")
        assertNull(MagicRules.limitHit(five, b.id, seatMoves = 0, sessionMoves = 5, items = 4, backstop = 5000), "B may still move it")
    }

    @Test
    fun `when deciding then any column is allowed and only an unmarked card decided away from its column is overridden`() {
        val unmarked = anItem(session, 0, column = "5")
        val marked = anItem(session, 1, column = "?", marked = true)

        assertEquals(false, MagicRules.decision(session, unmarked, "5"), "its column")
        assertEquals(true, MagicRules.decision(session, unmarked, "8"), "another column of an unmarked card")
        assertEquals(false, MagicRules.decision(session, marked, "13"), "a marked card is never overridden")
        assertNull(MagicRules.decision(session, marked, "coffee"), "coffee is no decision")
        assertNull(MagicRules.decision(session, marked, "4"), "not in the deck")
    }
}
