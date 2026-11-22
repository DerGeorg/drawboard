// The JDK HTTP client takes java.time.Duration: one of the few places outside the converters of core that has to name it.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.gifs.domain.search.requires.impl

import at.dergeorg.drawboard.gifs.domain.search.GifRules
import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.gifs.domain.search.requires.GifUpstream
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamEndpoint
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailure
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailureKind
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamGif
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamPage
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.reactor.awaitSingleOrNull
import kotlinx.coroutines.withTimeout
import org.springframework.beans.factory.DisposableBean
import org.springframework.beans.factory.ObjectProvider
import org.springframework.core.io.buffer.DataBufferLimitException
import org.springframework.http.MediaType
import org.springframework.http.client.reactive.JdkClientHttpConnector
import org.springframework.stereotype.Component
import org.springframework.web.reactive.function.client.ClientResponse
import org.springframework.web.reactive.function.client.WebClient
import reactor.core.publisher.Mono
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.net.http.HttpClient
import java.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * The GIPHY adapter (G1, G2, G4). The ONLY place that knows the key, and the only caller of GIPHY's API.
 *
 * * Address: the constant [GIPHY_BASE] (a test may name another through an [UpstreamEndpoint] bean, nothing else can), no redirect
 *   is followed, 2 seconds to connect, 5 seconds for the whole answer, at most 2 MB of body.
 * * Sent: `api_key`, `q`, `limit`, `offset`, `rating`, `lang` and an `Accept` header. Never a header of the caller, never an
 *   identifier of the user or the client (GIPHY sees the server).
 * * Read: `id`, `title` and the size of `images.original` of each entry, nothing else; no URL of GIPHY is passed on.
 * * The key is a query parameter, so it is in every request URI - and a framework exception names the URI. Therefore: this
 *   client is built with `WebClient.builder()` and no observation registry (no HTTP client span, no `http.url`), every failure
 *   leaves as an [UpstreamFailure] with a fixed word as message and no cause, and the span of the call (name: the host, outcome: the
 *   fixed word of the failure) is the one of `@WithSpan`. Nothing here logs.
 */
@Component
internal class GiphyUpstream(settings: GifsSettings, endpoint: ObjectProvider<UpstreamEndpoint>) : GifUpstream, DisposableBean {

    private val key = settings.apiKey
    private val mapper = JsonMapper.builder().build()

    // The JDK client, not Reactor Netty: Reactor Netty logs the request URI of every call at DEBUG ("Handler is being applied"),
    // and the URI holds the key and the search text. The JDK client logs nothing unless the JVM is started with a system property.
    private val http: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofMillis(CONNECT_TIMEOUT_MILLIS))
        .version(HttpClient.Version.HTTP_1_1)
        .build()

    private val client: WebClient = WebClient.builder()
        .baseUrl((endpoint.getIfAvailable()?.baseUrl ?: GIPHY_BASE).trimEnd('/'))
        .clientConnector(JdkClientHttpConnector(http))
        .codecs { it.defaultCodecs().maxInMemorySize(MAX_BODY_BYTES) }
        .build()

    override fun destroy() = http.shutdownNow()

    @WithSpan("GIPHY api.giphy.com search")
    override suspend fun search(term: String, page: Int, rating: Rating, lang: String): UpstreamPage = fetch(
        "/search",
        mapOf("q" to term, "limit" to GifRules.PAGE_SIZE.toString(), "offset" to (page * GifRules.PAGE_SIZE).toString(),
            "rating" to rating.wire, "lang" to lang),
    )

    @WithSpan("GIPHY api.giphy.com trending")
    override suspend fun trending(rating: Rating): UpstreamPage = fetch(
        "/trending",
        mapOf("limit" to GifRules.PAGE_SIZE.toString(), "offset" to "0", "rating" to rating.wire),
    )

    private suspend fun fetch(path: String, parameters: Map<String, String>): UpstreamPage {
        val apiKey = key ?: throw UpstreamFailure(UpstreamFailureKind.KEY_REFUSED) // not reachable: the service checks first
        val variables = parameters + ("api_key" to apiKey.reveal())
        val body = try {
            withTimeout(RESPONSE_TIMEOUT) {
                client.get()
                    .uri { builder ->
                        variables.keys.fold(builder.path(path)) { uri, name -> uri.queryParam(name, "{$name}") }.build(variables)
                    }
                    .accept(MediaType.APPLICATION_JSON)
                    .exchangeToMono(::read)
                    .awaitSingleOrNull()
            }
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            // the outermost layer towards GIPHY: whatever the HTTP client throws names the request URI (and so the key)
            throw translated(e)
        }
        return parse(body ?: throw UpstreamFailure(UpstreamFailureKind.BAD_RESPONSE))
    }

    /** What the caller of the adapter sees instead of [e]: a failure with a fixed word; a cancellation of the caller stays one. */
    private fun translated(e: Exception): Exception = when (e) {
        is UpstreamFailure -> e
        is TimeoutCancellationException -> UpstreamFailure(UpstreamFailureKind.TIMEOUT)
        is CancellationException -> e
        is DataBufferLimitException -> UpstreamFailure(UpstreamFailureKind.BAD_RESPONSE) // more than 2 MB, no Content-Length said so
        else -> UpstreamFailure(UpstreamFailureKind.UNREACHABLE)
    }

    /** 2xx: the body (at most 2 MB, the codec stops at the limit); anything else: the fixed failure for its status, body unread. */
    private fun read(response: ClientResponse): Mono<ByteArray> {
        val status = response.statusCode().value()
        if (status !in HTTP_OK_RANGE) {
            val failure = UpstreamFailure(kindOf(status), if (status == HTTP_TOO_MANY_REQUESTS) retryAfterOf(response) else null)
            return response.releaseBody().then(Mono.error(failure))
        }
        val length = response.headers().contentLength()
        if (length.isPresent && length.asLong > MAX_BODY_BYTES) {
            return response.releaseBody().then(Mono.error(UpstreamFailure(UpstreamFailureKind.BAD_RESPONSE)))
        }
        return response.bodyToMono(ByteArray::class.java)
    }

    private fun kindOf(status: Int) = when {
        status == HTTP_TOO_MANY_REQUESTS -> UpstreamFailureKind.RATE_LIMITED
        status == HTTP_UNAUTHORIZED || status == HTTP_FORBIDDEN -> UpstreamFailureKind.KEY_REFUSED
        status >= HTTP_SERVER_ERROR -> UpstreamFailureKind.SERVER_ERROR
        else -> UpstreamFailureKind.BAD_RESPONSE // a 3xx is never followed, any other 4xx is a request GIPHY does not take
    }

    private fun retryAfterOf(response: ClientResponse): Long? =
        response.headers().header("Retry-After").firstOrNull()?.trim()?.toLongOrNull()

    /** Only `data[].id`, `data[].title`, `data[].images.original.width/height` and `pagination.total_count` are read. */
    private fun parse(body: ByteArray): UpstreamPage = try {
        val root = mapper.readTree(body)
        val data = root.path("data")
        if (!data.isArray) throw UpstreamFailure(UpstreamFailureKind.BAD_RESPONSE)
        val total = root.path("pagination").path("total_count").takeIf { it.isNumber }?.asInt()
        UpstreamPage(data.asSequence().take(GifRules.PAGE_SIZE).map(::entry).toList(), total)
    } catch (e: UpstreamFailure) {
        throw e
    } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
        throw UpstreamFailure(UpstreamFailureKind.BAD_RESPONSE)
    }

    private fun entry(node: JsonNode): UpstreamGif {
        val original = node.path("images").path("original")
        return UpstreamGif(
            id = text(node.path("id")),
            title = text(node.path("title")),
            width = number(original.path("width")),
            height = number(original.path("height")),
        )
    }

    private fun text(node: JsonNode): String? = if (node.isString) node.asString() else null

    /** GIPHY writes sizes as strings ("480"); a number is accepted too, anything else is "no size". */
    private fun number(node: JsonNode): Int? = when {
        node.isInt -> node.asInt()
        node.isString -> node.asString().trim().toIntOrNull()
        else -> null
    }

    private companion object {
        const val GIPHY_BASE = "https://api.giphy.com/v1/gifs/"
        const val CONNECT_TIMEOUT_MILLIS = 2000L
        const val MAX_BODY_BYTES = 2 * 1024 * 1024
        val RESPONSE_TIMEOUT = 5.seconds
        val HTTP_OK_RANGE = 200..299
        const val HTTP_TOO_MANY_REQUESTS = 429
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
        const val HTTP_SERVER_ERROR = 500
    }
}
