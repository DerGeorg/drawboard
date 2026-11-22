package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.ApiKey
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * What the module is told (decisions G1, G6, G7). The defaults are the numbers of the decision; the properties only expose the
 * key, the rating and the budget, and tests shrink the rest. [apiKey] null = GIF search is off.
 *
 * @param hourlyBudget calls to GIPHY per hour for the whole instance (a new GIPHY key is a beta key with 100 calls per hour).
 */
internal data class GifsSettings(
    val apiKey: ApiKey?,
    val rating: Rating = Rating.G,
    val hourlyBudget: Int = DEFAULT_HOURLY_BUDGET,
    val userPerMinute: Int = USER_PER_MINUTE,
    val userPerHour: Int = USER_PER_HOUR,
    val cacheEntries: Int = CACHE_ENTRIES,
    val searchTtl: Duration = 15.minutes,
    val trendingTtl: Duration = 30.minutes,
    val failureTtl: Duration = 30.seconds,
) {
    init {
        require(hourlyBudget >= 1) { "DRAWBOARD_GIPHY_HOURLY_BUDGET must be at least 1" }
        require(userPerMinute >= 1 && userPerHour >= 1 && cacheEntries >= 1) { "the GIF limits must be positive" }
    }

    val enabled: Boolean get() = apiKey != null

    /** The hour of the budget and of the per-user limit. */
    val hour: Duration get() = 1.hours

    /** The settings without the key: what the start log and the tests may print. */
    override fun toString(): String = "GifsSettings(enabled=$enabled, rating=${rating.wire}, hourlyBudget=$hourlyBudget)"

    companion object {
        const val DEFAULT_HOURLY_BUDGET = 90
        const val USER_PER_MINUTE = 10
        const val USER_PER_HOUR = 40
        const val CACHE_ENTRIES = 500
    }
}
