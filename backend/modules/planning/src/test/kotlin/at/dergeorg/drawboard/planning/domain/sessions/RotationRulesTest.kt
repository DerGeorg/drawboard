package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RotationRulesTest {

    private val session = aSession(state = SessionState.REVIEW)

    @Test
    fun `when a card has no previous value then the entry needs no reason and keeps none (E6)`() {
        assertEquals(RotationInput.Entry(reason = null, kept = false), RotationRules.entry(null, "5", "because"), "first entry")
    }

    @Test
    fun `when the holder enters the previous value then it is kept and a reason is discarded`() {
        assertEquals(RotationInput.Entry(reason = null, kept = true), RotationRules.entry("5", "5", "anything"), "kept")
    }

    @Test
    fun `when the holder changes the value then a reason is required, and taken when given`() {
        assertEquals(RotationInput.ReasonRequired, RotationRules.entry("5", "8", null), "no reason")
        assertEquals(RotationInput.Entry(reason = "API", kept = false), RotationRules.entry("5", "8", "API"), "with a reason")
    }

    @Test
    fun `when deciding a card with entries then only an entered value is allowed and never overridden`() {
        val card = anItem(session, 0)
        val entries = listOf(anEntry(card, null, 0, "5"), anEntry(card, null, 1, "8"))

        assertEquals(false, RotationRules.decision(session, entries, "8"), "an entered value")
        assertNull(RotationRules.decision(session, entries, "13"), "a deck value nobody entered")
    }

    @Test
    fun `when deciding a card without entries then any deck value is allowed and overridden`() {
        assertEquals(true, RotationRules.decision(session, emptyList(), "13"), "overridden")
        assertNull(RotationRules.decision(session, emptyList(), "4"), "not in the deck")
    }
}
