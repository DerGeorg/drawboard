package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class SessionResultsTest {

    private val anna = Principal.Member(Uuid.generateV7(), "Anna")
    private val gus = Principal.Guest(Uuid.random(), "Gus", Uuid.generateV7())

    @Test
    fun `when a rotation card is reviewed then its entries come in the stored random order with mean, median and distribution`() {
        val session = aSession(state = SessionState.REVIEW)
        val card = anItem(session, 0)
        val entries = listOf(
            anEntry(card, null, round = 0, value = "3", shuffle = 30),
            anEntry(card, null, round = 1, value = "8", reason = "API", shuffle = 10),
            anEntry(card, null, round = 2, value = "5", reason = "less", shuffle = 20),
        )

        val result = SessionResults.of(session, card, entries, emptyList(), emptyMap(), reduced = false)

        assertEquals(listOf("8", "5", "3"), result.entries.map { it.value }, "by the shuffle key, never by round")
        assertEquals(listOf("API", "less", null), result.entries.map { it.reason }, "reasons")
        assertEquals(5.33 to 5.0, result.average to result.median, "mean and median")
        assertEquals(listOf(ValueCount("3", 1), ValueCount("5", 1), ValueCount("8", 1)), result.distribution, "in deck order")
        assertEquals(listOf("3", "5", "8"), result.candidates, "the values entered, in deck order")
        assertEquals(emptyList(), result.moveTrail, "no trail in rotation")
    }

    @Test
    fun `when the session is anonymous then no entry has a name, otherwise each has the name of its seat`() {
        val anonymous = aSession(state = SessionState.REVIEW, anonymous = true)
        val named = anonymous.copy(anonymous = false)
        val annaSeat = aSeat(named, anna, slot = 0)
        val gusSeat = aSeat(named, gus, slot = 1)
        val card = anItem(named, 0)
        val entries = listOf(anEntry(card, annaSeat, 0, "3", shuffle = 1), anEntry(card, gusSeat, 1, "5", reason = "x", shuffle = 2))
        val seats = listOf(annaSeat, gusSeat).associateBy { it.id }

        val hidden = SessionResults.of(anonymous, card, entries, emptyList(), seats, reduced = false)
        val shown = SessionResults.of(named, card, entries, emptyList(), seats, reduced = false)

        assertEquals(listOf(null, null), hidden.entries.map { it.displayName }, "anonymous: no names")
        assertEquals(listOf("Anna" to false, "Gus" to true), shown.entries.map { it.displayName to it.guest }, "named, guest flagged")
        assertEquals(listOf(anna.id, null), shown.entries.map { it.userId }, "a member's id for the deleted-user check, never a guest's")
    }

    @Test
    fun `when 30 days after DONE have passed then entries and the trail are gone and the numbers stay (E22)`() {
        val session = aSession(state = SessionState.DONE)
        val card = anItem(session, 0)
        val entries = listOf(anEntry(card, null, 0, "3"), anEntry(card, null, 1, "5", reason = "x"))

        val result = SessionResults.of(session, card, entries, emptyList(), emptyMap(), reduced = true)

        assertEquals(emptyList(), result.entries, "no single value, no reason")
        assertEquals(4.0, result.average, "the mean stays")
        assertEquals(listOf("3", "5"), result.candidates, "the candidates stay")
    }

    @Test
    fun `when a magic card is reviewed then it has its trail and the candidates follow the mark`() {
        val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.REVIEW)
        val unmarked = anItem(session, 0, column = "5")
        val marked = anItem(session, 1, column = "?", marked = true)
        val moves = listOf(aMove(unmarked, null, "3", "5", T0 + 1.seconds))

        val plain = SessionResults.of(session, unmarked, emptyList(), moves, emptyMap(), reduced = false)
        val discussed = SessionResults.of(session, marked, emptyList(), moves, emptyMap(), reduced = false)

        assertEquals(listOf("3", "5"), plain.moveTrail, "placed in 3, moved to 5")
        assertEquals(listOf("5"), plain.candidates, "an unmarked card: its column")
        assertEquals(MagicMarks.columns(session.deck), discussed.candidates, "a marked card: every column")
        assertEquals(listOf("?"), discussed.moveTrail, "never moved")
        assertNull(plain.average, "no mean in magic")
    }
}
