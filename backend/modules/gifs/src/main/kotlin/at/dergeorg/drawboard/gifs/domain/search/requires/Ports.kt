package at.dergeorg.drawboard.gifs.domain.search.requires

import at.dergeorg.drawboard.gifs.domain.search.model.Rating

/** Port: GIPHY. The adapter owns the key, the address, the timeouts and the mapping; the domain sees entries and failures only. */
internal interface GifUpstream {

    /** One page of [page] (24 per page) for [term] in [lang]. [term] is normalised already. Throws [UpstreamFailure], nothing else. */
    suspend fun search(term: String, page: Int, rating: Rating, lang: String): UpstreamPage

    /** The first page of the trending GIFs. Throws [UpstreamFailure], nothing else. */
    suspend fun trending(rating: Rating): UpstreamPage
}

/** One entry of GIPHY's answer as the adapter read it: nothing is checked yet, a field may be missing or of the wrong kind (null). */
internal data class UpstreamGif(val id: String?, val title: String?, val width: Int?, val height: Int?)

/** What GIPHY answered: the entries (at most 24) and, for a search, `pagination.total_count`. */
internal data class UpstreamPage(val entries: List<UpstreamGif>, val totalCount: Int?)

/** Why a call to GIPHY failed. The [token] is a fixed word: it is the only thing that is logged and traced about the failure (G2). */
internal enum class UpstreamFailureKind(val token: String) {
    TIMEOUT("timeout"),
    UNREACHABLE("unreachable"),
    KEY_REFUSED("key_refused"),
    RATE_LIMITED("rate_limited"),
    SERVER_ERROR("server_error"),
    BAD_RESPONSE("bad_response"),
}

/**
 * The only exception the GIPHY adapter lets out. Its message is the fixed [UpstreamFailureKind.token] and it has no cause and no
 * stack trace: a framework exception of the HTTP client carries the request URI, and that holds the API key (G2).
 * [retryAfterSeconds] is GIPHY's own `Retry-After` of a 429, if it sent one.
 */
internal class UpstreamFailure(val kind: UpstreamFailureKind, val retryAfterSeconds: Long? = null) :
    RuntimeException(kind.token, null, false, false)

/**
 * The address of GIPHY's API (G4). The adapter uses a constant; a bean of this type exists in TESTS only, to point the adapter at a
 * fake server. No property, no environment variable can change it: the key travels to this host and to no other.
 */
class UpstreamEndpoint(val baseUrl: String)

/** What a request came to, for the counter `drawboard.gifs.requests{outcome}` (G8). Never a search text, a user or a key. */
enum class RequestOutcome(val label: String) {
    HIT("hit"),
    MISS("miss"),
    UPSTREAM_ERROR("upstream_error"),
    LIMITED_USER("limited_user"),
    LIMITED_INSTANCE("limited_instance"),
    DISABLED("disabled"),
}

/** Port: the metric of the module. */
internal interface GifsMetrics {
    fun request(outcome: RequestOutcome)
}
