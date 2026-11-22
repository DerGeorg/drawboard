package at.dergeorg.drawboard.planning.domain.common

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import java.math.BigDecimal
import java.math.RoundingMode

/** The statistics of a set of chosen deck values; [average] and [median] are null without a numeric value. */
internal data class ValueStatistics(
    val average: Double?,
    val median: Double?,
    val distribution: List<ValueCount>,
    val suggestion: String?,
)

/**
 * The statistics of chosen deck values, shared by the poker rounds and the estimation sessions: the mean and the median of the numeric
 * values (two decimals, half up), how often each value was chosen (in deck order), and the suggestion - the value chosen most often,
 * ignoring `?` and `coffee`, the higher one (later in the deck) on a tie.
 */
internal object ValueStats {

    private val NUMERIC = Regex("^[0-9]+(\\.[0-9]+)?$")
    private val NO_ESTIMATE = setOf("?", "coffee")
    private const val SCALE = 2
    private const val PRECISION = 10

    fun of(deck: Deck, values: List<String>): ValueStatistics {
        val numbers = values.filter(NUMERIC::matches).map(::BigDecimal).sorted()
        val counts = values.groupingBy { it }.eachCount()
        val distribution = deck.values.mapNotNull { value -> counts[value]?.let { ValueCount(value, it) } }
        return ValueStatistics(
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
