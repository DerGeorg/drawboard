package at.dergeorg.drawboard.planning.domain.rounds

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.ResultVote
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundResult
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * The result of a revealed round, computed from the votes (nothing of it is stored): every vote in the order of joining, the mean and
 * the median of the numeric deck values, how often each value was chosen, and the suggestion - the value chosen most often, ignoring
 * `?` and `coffee`, the higher one (later in the deck) on a tie.
 */
internal object RoundResults {

    private val NUMERIC = Regex("^[0-9]+(\\.[0-9]+)?$")
    private val NO_ESTIMATE = setOf("?", "coffee")
    private const val SCALE = 2
    private const val PRECISION = 10

    fun of(deck: Deck, participants: List<StoredParticipant>): RoundResult {
        val voted = participants.filter { it.vote != null }
        val votes = voted.map { ResultVote(it.displayName, it.guest, checkNotNull(it.vote), if (it.guest) null else it.principalId) }
        val numbers = votes.map { it.value }.filter(NUMERIC::matches).map(::BigDecimal).sorted()
        val counts = votes.groupingBy { it.value }.eachCount()
        val distribution = deck.values.mapNotNull { value -> counts[value]?.let { ValueCount(value, it) } }
        return RoundResult(
            votes = votes,
            average = if (numbers.isEmpty()) null else round(mean(numbers)),
            median = if (numbers.isEmpty()) null else round(median(numbers)),
            distribution = distribution,
            suggestion = suggestion(deck, distribution),
        )
    }

    private fun mean(numbers: List<BigDecimal>): BigDecimal =
        numbers.fold(BigDecimal.ZERO, BigDecimal::add).divide(BigDecimal(numbers.size), PRECISION, RoundingMode.HALF_UP)

    private fun median(sorted: List<BigDecimal>): BigDecimal {
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[middle] else (sorted[middle - 1] + sorted[middle]).divide(BigDecimal(2))
    }

    /** The most chosen estimate; the loop keeps the later value on a tie because the distribution is in deck order. */
    private fun suggestion(deck: Deck, distribution: List<ValueCount>): String? {
        var best: ValueCount? = null
        for (candidate in distribution) {
            if (candidate.value in NO_ESTIMATE) continue
            if (best == null || candidate.count >= best.count) best = candidate
        }
        return best?.value.also { check(it == null || it in deck.values) { "a suggestion is a value of the deck" } }
    }

    private fun round(value: BigDecimal): Double = value.setScale(SCALE, RoundingMode.HALF_UP).toDouble()
}
