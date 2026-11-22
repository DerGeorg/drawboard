package at.dergeorg.drawboard.planning.domain.common

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ValueStatsTest {

    @Test
    fun `when values are numeric then mean and median are rounded to two decimals`() {
        val stats = ValueStats.of(Deck.FIBONACCI, listOf("1", "2", "13", "13"))

        assertEquals(7.25 to 7.5, stats.average to stats.median, "mean and median of 1, 2, 13, 13")
    }

    @Test
    fun `when no value is numeric then there is no average, no median and no suggestion`() {
        val stats = ValueStats.of(Deck.FIBONACCI, listOf("?", "coffee"))

        assertEquals(listOf(null, null, null), listOf(stats.average, stats.median, stats.suggestion), "nothing to compute")
        assertEquals(listOf(ValueCount("?", 1), ValueCount("coffee", 1)), stats.distribution, "still counted, in deck order")
    }

    @Test
    fun `when two values tie then the later one in the deck is suggested`() {
        val stats = ValueStats.of(Deck.FIBONACCI, listOf("8", "5", "8", "5"))

        assertEquals("8", stats.suggestion, "the higher one")
    }

    @Test
    fun `when there are no values then everything is empty`() {
        val stats = ValueStats.of(Deck.TSHIRT, emptyList())

        assertNull(stats.average, "no average")
        assertEquals(emptyList(), stats.distribution, "no distribution")
    }
}
