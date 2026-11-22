package at.dergeorg.drawboard.integration.gifs

import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.integration.CapturedSpans
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.gif
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.page
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.respond
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
import io.opentelemetry.sdk.trace.data.SpanData
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.boot.logging.LogLevel
import org.springframework.boot.logging.LoggingSystem
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

private data class Quad(val id: String, val title: String, val width: Int, val height: Int)

/**
 * GIF search end to end (3.14, G1-G8) against a fake GIPHY: real tokens, a real port, the application with a key. The HTTP client of the
 * adapter and Reactor Netty log at DEBUG here on purpose - the key is a query parameter, and the strongest test that it is in no log
 * line is to ask the libraries that print URLs to do so.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/gifs-integration",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "DRAWBOARD_GIPHY_API_KEY=$GIPHY_TEST_KEY",
        "management.otlp.metrics.export.enabled=false",
        "logging.level.org.springframework.web.reactive.function.client=DEBUG",
        "logging.level.org.springframework.http.client.reactive=DEBUG",
        "logging.level.reactor.netty.http.client=DEBUG",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(FakeGiphyConfiguration::class, CapturedSpans::class)
@ExtendWith(OutputCaptureExtension::class)
class GifsIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val giphy: FakeGiphyServer,
    private val spans: CapturedSpans,
    private val meters: MeterRegistry,
    private val loggingSystem: LoggingSystem,
) {

    @BeforeEach
    fun reset() {
        giphy.reset()
        spans.clear()
    }

    /** A user nobody has seen: every user has 10 searches a minute, and the tests must not share them. */
    private fun user() = SharingUser(client, port, "Gif ${Uuid.random()}").http()

    private fun WebTestClient.search(q: String, page: Int? = null, lang: String? = null) =
        post().uri("/api/gifs/search").bodyValue(GifSearch(q, page, lang)).exchange()

    private fun WebTestClient.searchPage(q: String) = search(q).expectBody<GifPage>().returnResult()

    private fun WebTestClient.searchError(q: String) = search(q).expectBody<ErrorModel>().returnResult()

    private fun term() = "term${Uuid.random().toString().replace("-", "")}"

    private fun count(outcome: String) = meters.find("drawboard.gifs.requests").tag("outcome", outcome).counter()?.count() ?: 0.0

    @Nested
    inner class Enabled {

        @Test
        fun `when the application has started with a key then no call to GIPHY was made`() {
            assertEquals(0, giphy.requestsAtStart, "G1: nothing is asked of GIPHY at the start; the first call is a user's")
        }

        @Test
        fun `when GET users me given a key then gifsEnabled is true`() {
            val me = user().get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody

            assertEquals(true, me?.gifsEnabled, "G3: the key is there")
        }
    }

    @Nested
    inner class Search {

        @Test
        fun `when a user searches then GIPHY is asked for the normalised text with the key, the rating and nothing of the user`() {
            giphy.handler = { respond(it, 200, page(gif("abc123"), gif("def456", title = "Second"), total = 100)) }

            val result = user().search("  Happy   CAT ", page = 2, lang = "de").expectBody<GifPage>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status")
            assertEquals(listOf("abc123", "def456"), result.responseBody?.items?.map { it.id }, "the GIFs")
            assertEquals(true, result.responseBody?.hasMore, "48 + 2 of 100: more")
            assertEquals("no-store", result.responseHeaders.getFirst(HttpHeaders.CACHE_CONTROL),
                "G8: the answer is not cached by the client")
            val seen = giphy.requests.single()
            assertEquals("/v1/gifs/search", seen.path, "path")
            assertEquals(
                mapOf("api_key" to GIPHY_TEST_KEY, "q" to "happy cat", "limit" to "24", "offset" to "48", "rating" to "g", "lang" to "de"),
                seen.query,
                "G4: key, text, limit, offset, rating, language",
            )
            val allowed = setOf("accept", "host", "user-agent", "accept-encoding", "connection", "content-length")
            assertEquals(emptySet(), seen.headers.keys - allowed, "no header of the caller goes along: ${seen.headers.keys}")
        }

        @Test
        fun `when the answer holds more than id, title and size then only those reach the client, and no GIPHY address`() {
            giphy.handler = { respond(it, 200, page(gif("abc123", title = "Cat <script>x</script> \u202Eevil\u0007"))) }

            val result = user().search(term()).expectBody<String>().returnResult()

            val body = checkNotNull(result.responseBody)
            val items = json.readValue(body, GifPage::class.java).items
            assertEquals(listOf(Quad("abc123",
                "Cat <script>x</script> evil", 480, 270)), items.map { Quad(it.id, it.title, it.width, it.height) },
                "G4: four fields, the title without control and bidi characters: $body")
            assertTrue("http" !in body && "giphy.com" !in body && "someone" !in body, "no URL, no user name of GIPHY: $body")
        }

        @Test
        fun `when entries are invalid then they are dropped`() {
            giphy.handler = {
                respond(
                    it, 200,
                    page(
                        gif("good1"), gif("bad/id"), gif("zero1", width = "0"), gif("huge1", height = "5000"), gif("nosize", width = "x"),
                        gif("good2"),
                    ),
                )
            }

            val items = user().searchPage(term()).responseBody?.items.orEmpty()

            assertEquals(listOf("good1", "good2"), items.map { it.id }, "G4: id pattern and sizes 1..4096")
        }

        @Test
        fun `when the page is 9 then hasMore is false however many results there are`() {
            giphy.handler = { respond(it, 200, page(*Array(24) { n -> gif("g$n") }, total = 100_000)) }

            val last = user().search(term(), page = 9).expectBody<GifPage>().returnResult().responseBody

            assertEquals(false, last?.hasMore, "page 9 is the last the contract allows")
            assertEquals("216", giphy.requests.single().query["offset"], "offset 9 * 24")
        }

        @Test
        fun `when a client sends a rating or a key of its own then GIPHY gets the instance's`() {
            val http = user()

            http.post().uri("/api/gifs/search?rating=r&api_key=mine&limit=500&offset=9").bodyValue(
                mapOf("q" to term(), "rating" to "r", "api_key" to "mine", "limit" to 500, "offset" to 7),
            ).exchange().expectBody<String>().returnResult()

            val seen = giphy.requests.single().query
            assertEquals(listOf("g", GIPHY_TEST_KEY, "24", "0"), listOf("rating", "api_key", "limit", "offset").map { seen.getValue(it) },
                "G6")
        }

        @Test
        fun `when the text is too short or the input invalid then 400 VALIDATION_FAILED and GIPHY is not asked`() {
            val http = user()

            val short = http.searchError(" a ")
            val empty = http.searchError("")
            val control = http.searchError("cat\u0007")
            val page10 = http.search("cat", page = 10).expectBody<ErrorModel>().returnResult()
            val lang = http.search("cat", lang = "DE").expectBody<ErrorModel>().returnResult()

            listOf(short, empty, control, page10, lang).forEachIndexed { index, result ->
                assertEquals(HttpStatus.BAD_REQUEST, result.status, "case $index")
                assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "case $index: error code")
            }
            assertEquals(emptyList(), giphy.requests, "invalid input is not sent on")
        }

        @Test
        fun `when nobody is signed in then 401 and GIPHY is not asked`() {
            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch("cat")).exchange()
                .expectBody<ErrorModel>().returnResult()
            val trending = client.get().uri("/api/gifs/trending").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(listOf(HttpStatus.UNAUTHORIZED, HttpStatus.UNAUTHORIZED), listOf(result.status, trending.status), "status")
            assertEquals(emptyList(), giphy.requests, "no call")
        }

        @Test
        fun `when the same text is searched again then the second answer comes from the cache`() {
            giphy.handler = { respond(it, 200, page(gif("cached1"))) }
            val text = term()
            val hits = count("hit")
            val misses = count("miss")

            val first = user().searchPage(text).responseBody
            val second = user().searchPage(" ${text.uppercase()} ").responseBody

            assertEquals(first, second, "the same page")
            assertEquals(1, giphy.requests.size, "one call to GIPHY for two users")
            assertEquals(1.0 to 1.0, (count("miss") - misses) to (count("hit") - hits), "one miss, one hit")
        }
    }

    @Nested
    inner class Trending {

        @Test
        fun `when listing trending then GIPHY gets the key, limit, offset and rating only, the answer has no more pages and is cached`() {
            giphy.handler = { respond(it, 200, page(*Array(24) { n -> gif("t$n") }, total = 5000)) }
            val http = user()

            val first = http.get().uri("/api/gifs/trending").exchange().expectBody<GifPage>().returnResult()
            val second = http.get().uri("/api/gifs/trending").exchange().expectBody<GifPage>().returnResult()

            assertEquals(HttpStatus.OK, first.status, "status")
            assertEquals(24 to false, first.responseBody?.items?.size to first.responseBody?.hasMore, "24 GIFs, no more pages")
            assertEquals("no-store", first.responseHeaders.getFirst(HttpHeaders.CACHE_CONTROL), "Cache-Control")
            assertEquals(first.responseBody, second.responseBody, "the same page")
            val seen = giphy.requests.single()
            assertEquals("/v1/gifs/trending", seen.path, "one call for two requests")
            assertEquals(mapOf("api_key" to GIPHY_TEST_KEY, "limit" to "24", "offset" to "0", "rating" to "g"), seen.query, "parameters")
        }
    }

    @Nested
    inner class Limits {

        @Test
        fun `when a user searches 10 times in a minute then the 11th is 429 - cache hits count, other users are not affected`() {
            val http = user()
            val text = term()
            val limited = count("limited_user")

            repeat(10) { assertEquals(HttpStatus.OK, http.search(text).expectBody<String>().returnResult().status, "request ${it + 1}") }
            val eleventh = http.searchError(text)
            val other = user().search(text).expectBody<String>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, eleventh.status, "11th request")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, eleventh.responseBody?.code, "error code")
            assertTrue((eleventh.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER)?.toLongOrNull() ?: 0) in 1..60,
                "Retry-After: ${eleventh.responseHeaders}")
            assertEquals(HttpStatus.OK, other.status, "another user is not limited")
            assertEquals(1, giphy.requests.size, "ten requests of one user and one of another: one call (G7)")
            assertEquals(1.0, count("limited_user") - limited, "counted as limited_user")
        }

        @Test
        fun `when a user is limited then trending is limited too`() {
            val http = user()
            repeat(10) { http.get().uri("/api/gifs/trending").exchange().expectBody<String>().returnResult() }

            val result = http.get().uri("/api/gifs/trending").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, result.responseBody?.code, "the limit is per user for both")
        }
    }

    @Nested
    inner class Guests {

        private fun guestSession(): String {
            val owner = SharingUser(client, port, "Gif Olga")
            val board = owner.createBoard()
            val created = owner.http().post().uri("/api/boards/${board.id}/links")
                .bodyValue(NewShareLink(GrantRole.EDITOR, ShareAudience.GUESTS, null, null)).exchange()
                .expectBody<CreatedShareLink>().returnResult()
            val token = checkNotNull(created.responseBody).url.substringAfter('#')
            val access = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", "10.7.7.7")
                .bodyValue(ShareExchange(token, null, "Gus")).exchange().expectBody<String>().returnResult()
            return checkNotNull(json.readValue(checkNotNull(access.responseBody), ShareAccess::class.java).guestSession).accessToken
        }

        @Test
        fun `when a guest with an EDITOR link searches or lists trending then 403 FORBIDDEN and GIPHY is not asked`() {
            val guest = client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${guestSession()}").build()

            val search = guest.searchError("cat")
            val trending = guest.get().uri("/api/gifs/trending").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(listOf(HttpStatus.FORBIDDEN, HttpStatus.FORBIDDEN), listOf(search.status, trending.status), "G5, S1.8 unchanged")
            assertEquals(listOf(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN), listOf(search.responseBody?.code, trending.responseBody?.code),
                "codes")
            assertEquals(emptyList(), giphy.requests, "no call")
        }
    }

    @Nested
    inner class Failures {

        private fun failing(status: Int, vararg headers: Pair<String, String>) {
            giphy.handler = { respond(it, status, """{"message":"The API key $GIPHY_TEST_KEY is invalid"}""", *headers) }
        }

        @Test
        fun `when GIPHY refuses the key or fails then 503 GIFS_UNAVAILABLE with Retry-After and no detail`() {
            val http = user()
            val failures = listOf(401, 403, 500, 502).map { status ->
                failing(status)
                http.searchError(term())
            }

            failures.forEach { result ->
                assertEquals(HttpStatus.SERVICE_UNAVAILABLE, result.status, "status")
                assertEquals(ErrorCode.GIFS_UNAVAILABLE, result.responseBody?.code, "error code")
                assertEquals("30", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
                assertTrue(GIPHY_TEST_KEY !in result.responseBody.toString() && "invalid" !in result.responseBody.toString(),
                    "no detail of GIPHY")
            }
        }

        @Test
        fun `when GIPHY sends something that is not a page then 503 GIFS_UNAVAILABLE`() {
            val http = user()
            val answers = listOf("not json", "{}", """{"data":"x"}""", "")
            val results = answers.map { body ->
                giphy.handler = { respond(it, 200, body) }
                http.searchError(term())
            }

            assertEquals(List(answers.size) { ErrorCode.GIFS_UNAVAILABLE }, results.map { it.responseBody?.code }, "codes")
        }

        @Test
        fun `when a call failed then the same text is not asked again for 30 seconds`() {
            val http = user()
            val text = term()
            failing(500)

            http.searchError(text)
            val again = http.searchError(text)

            assertEquals(ErrorCode.GIFS_UNAVAILABLE, again.responseBody?.code, "the failure is remembered")
            assertEquals(1, giphy.requests.size, "G7 SHOULD: one call")
        }

        @Test
        fun `when a call fails then the failure is counted as upstream_error`() {
            val before = count("upstream_error")
            failing(500)

            user().searchError(term())

            assertEquals(1.0, count("upstream_error") - before, "outcome")
        }
    }

    @Nested
    inner class NothingLeaks {

        private fun everythingAbout(spans: List<SpanData>): String = spans.joinToString("\n") { span ->
            listOf(
                span.name, span.attributes.toString(), span.status.description, span.resource.toString(),
                span.events.joinToString { "${it.name} ${it.attributes}" }, span.instrumentationScopeInfo.name,
            ).joinToString(" ")
        }

        @Test
        fun `when searches succeed, fail or time out then the key and the search texts are in no log, span, metric or answer`(
            output: CapturedOutput,
        ) {
            val http = user()
            val secret = "zebrafish${Uuid.random().toString().replace("-", "")}"
            val answers = mutableListOf<String>()
            fun ask(extra: String = "") = http.search("$secret $extra").expectBody<String>().returnResult().let {
                answers += it.responseBody.orEmpty()
                it.status
            }

            giphy.handler = { respond(it, 200, page(gif("ok1"))) }
            val ok = ask("ok")
            giphy.handler = { respond(it, 401, """{"message":"invalid api_key=$GIPHY_TEST_KEY"}""") }
            val refused = ask("refused")
            giphy.handler = { respond(it, 500, "server $GIPHY_TEST_KEY") }
            val broken = ask("broken")
            giphy.handler = { respond(it, 200, "garbage $GIPHY_TEST_KEY") }
            val garbage = ask("garbage")
            giphy.handler = { it.close() } // the connection is cut without an answer
            val cut = ask("cut")
            giphy.handler = { Thread.sleep(6_000) }
            val timeout = ask("slow")
            giphy.handler = { respond(it, 500, "server $GIPHY_TEST_KEY") }
            http.get().uri("/api/gifs/trending").exchange().expectBody<String>().returnResult() // a hit of an earlier test, or a 503

            assertEquals(
                listOf(HttpStatus.OK, HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE,
                    HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE),
                listOf(ok, refused, broken, garbage, cut, timeout),
                "the searches: success, 401, 500, garbage, cut connection, timeout (G2)",
            )
            val log = output.all
            assertTrue(giphy.requests.size >= 6 && giphy.requests.all { it.query["api_key"] == GIPHY_TEST_KEY },
                "the key did travel to GIPHY")
            assertTrue(GIPHY_TEST_KEY !in log, "G2: the key is in no log line")
            assertTrue(secret !in log, "G8: the search text is in no log line")
            val traces = everythingAbout(spans.finished)
            assertTrue(spans.finished.any { it.name.startsWith("GIPHY ") },
                "the call to GIPHY has a span of its own: ${spans.finished.map { it.name }}")
            assertTrue(GIPHY_TEST_KEY !in traces && "api_key" !in traces, "G2: the key is in no span")
            assertTrue(secret !in traces, "G8: the search text is in no span")
            assertTrue(answers.none { GIPHY_TEST_KEY in it || secret in it }, "nor in an answer: $answers")
            val metricsText = meters.meters.filter { it.id.name.startsWith("drawboard.gifs") }.joinToString { it.id.toString() }
            assertTrue(GIPHY_TEST_KEY !in metricsText && secret !in metricsText, "nor in a metric")
        }

        @Test
        fun `when the codec loggers are read then they are pinned to INFO, as at DEBUG they log every JSON body`() {
            val levels = listOf("org.springframework.http.codec", "org.springframework.core.codec")
                .map { loggingSystem.getLoggerConfiguration(it)?.effectiveLevel }

            assertEquals(List(2) { LogLevel.INFO }, levels, "application.yaml fixes both at INFO; this class does not raise them")
        }

        @Test
        fun `when a call to GIPHY is traced then its span names the host and ends with the fixed word of the outcome`() {
            giphy.handler = { respond(it, 500, "boom") }

            user().searchError(term())

            val span = spans.finished.first { it.name == "GIPHY api.giphy.com search" }
            assertEquals(false, span.status.statusCode.name == "OK", "a failed call marks its span: ${span.status}")
            val recorded = span.events.joinToString { it.attributes.toString() }
            assertTrue("server_error" in recorded, "the outcome is the fixed word: $recorded")
        }

        @Test
        fun `when the metric is read then it has the outcome label only, from the fixed set`() {
            user().search(term()).expectBody<String>().returnResult()

            val tags = meters.meters.filter { it.id.name == "drawboard.gifs.requests" }.flatMap { it.id.tags }
            assertEquals(setOf("outcome"), tags.map { it.key }.toSet(), "G8: one label")
            assertTrue(
                tags.map { it.value }.toSet().all { it in setOf("hit", "miss", "upstream_error", "limited_user", "limited_instance",
                    "disabled") },
                "values: $tags",
            )
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { generatedKey() }
        }

        private fun generatedKey(): String {
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            val body = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(pair.private.encoded)
            return "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
        }
    }
}
