package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.domain.rounds.RoundResults
import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.uuid.Uuid

class RoundResultsTest {

    private fun voters(vararg votes: String?) = votes.mapIndexed { index, vote ->
        StoredParticipant(Uuid.generateV7(), Uuid.generateV7(), ParticipantKind.USER, Uuid.generateV7(), null, "P$index", index + 1, vote,
            FIXED_NOW)
    }

    @Test
    fun `when votes are numeric then average and median are rounded to two decimals`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("1", "2", "13", "13"))

        assertEquals(7.25, result.average, "mean of 1, 2, 13, 13")
        assertEquals(7.5, result.median, "mean of the two middle ones")
    }

    @Test
    fun `when the count is odd then the median is the middle value, and a third is rounded half up`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("1", "1", "2"))

        assertEquals(1.33, result.average, "4/3 rounded")
        assertEquals(1.0, result.median, "middle of 1, 1, 2")
    }

    @Test
    fun `when decimals are in the deck then they count as numbers`() {
        val deck = Deck(DeckKind.CUSTOM, listOf("0.5", "1", "2"))

        val result = RoundResults.of(deck, voters("0.5", "1"))

        assertEquals(0.75, result.average, "0.5 is numeric")
    }

    @Test
    fun `when a vote is a question mark or coffee then it is no number and no suggestion`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("?", "coffee", "5", null))

        assertEquals(5.0 to 5.0, result.average to result.median, "only the 5 counts")
        assertEquals("5", result.suggestion, "the estimate, not the question mark")
        assertEquals(3, result.votes.size, "the one who did not vote has no vote")
    }

    @Test
    fun `when every vote is question mark or coffee then there is no suggestion and no average`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("?", "?", "coffee"))

        assertNull(result.suggestion, "no suggestion")
        assertNull(result.average, "no average")
        assertEquals(listOf(ValueCount("?", 2), ValueCount("coffee", 1)), result.distribution, "but the distribution lists them")
    }

    @Test
    fun `when two values are chosen equally often then the suggestion is the higher one - the later in the deck`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("8", "5", "8", "5"))

        assertEquals("8", result.suggestion, "tie goes up")
    }

    @Test
    fun `when t-shirt sizes are voted then there are no numbers but a suggestion`() {
        val result = RoundResults.of(Deck.TSHIRT, voters("M", "L", "L"))

        assertNull(result.average, "no numbers")
        assertEquals("L", result.suggestion, "L wins")
    }

    @Test
    fun `when the distribution is built then only chosen values appear, in deck order`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters("13", "2", "13"))

        assertEquals(listOf(ValueCount("2", 1), ValueCount("13", 2)), result.distribution, "deck order, counts")
    }

    @Test
    fun `when nobody voted then the result is empty`() {
        val result = RoundResults.of(Deck.FIBONACCI, voters(null, null))

        assertEquals(emptyList(), result.votes, "votes")
        assertNull(result.median, "median")
    }
}
