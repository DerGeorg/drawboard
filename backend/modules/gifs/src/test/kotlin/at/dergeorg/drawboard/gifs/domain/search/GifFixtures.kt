package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.ApiKey
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.gifs.domain.search.requires.GifUpstream
import at.dergeorg.drawboard.gifs.domain.search.requires.GifsMetrics
import at.dergeorg.drawboard.gifs.domain.search.requires.RequestOutcome
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamGif
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamPage

/** A key of the right shape that exists only in tests. Tests look for this text in logs, spans and answers. */
const val TEST_KEY = "TestKey0123456789abcdef"

fun aKey(): ApiKey = checkNotNull(ApiKey.parse(TEST_KEY)) { "the test key has a shape" }

internal fun settings(
    apiKey: ApiKey? = aKey(),
    rating: Rating = Rating.G,
    budget: Int = GifsSettings.DEFAULT_HOURLY_BUDGET,
    perMinute: Int = GifsSettings.USER_PER_MINUTE,
    perHour: Int = GifsSettings.USER_PER_HOUR,
) = GifsSettings(apiKey, rating, budget, perMinute, perHour)

internal fun entry(id: String = "abc123", title: String? = "A cat", width: Int? = 480, height: Int? = 270) =
    UpstreamGif(id, title, width, height)

internal fun page(vararg entries: UpstreamGif, total: Int? = entries.size) = UpstreamPage(entries.toList(), total)

/** A scripted GIPHY: every call is recorded, [answer] decides what comes back (or throws). */
internal class FakeUpstream(var answer: suspend (Call) -> UpstreamPage = { page(entry()) }) : GifUpstream {
    data class Call(val term: String?, val page: Int, val rating: Rating, val lang: String?)

    val calls = mutableListOf<Call>()

    override suspend fun search(term: String, page: Int, rating: Rating, lang: String): UpstreamPage =
        Call(term, page, rating, lang).let { calls += it; answer(it) }

    override suspend fun trending(rating: Rating): UpstreamPage = Call(null, 0, rating, null).let { calls += it; answer(it) }
}

internal class RecordingGifsMetrics : GifsMetrics {
    val outcomes = mutableListOf<RequestOutcome>()

    override fun request(outcome: RequestOutcome) {
        outcomes += outcome
    }
}
