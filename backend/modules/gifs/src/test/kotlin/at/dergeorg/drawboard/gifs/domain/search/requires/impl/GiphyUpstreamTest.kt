package at.dergeorg.drawboard.gifs.domain.search.requires.impl

import at.dergeorg.drawboard.gifs.domain.search.TEST_KEY
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamEndpoint
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailure
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailureKind
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamGif
import at.dergeorg.drawboard.gifs.domain.search.requires.impl.FakeGiphy.Companion.json
import at.dergeorg.drawboard.gifs.domain.search.settings
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The GIPHY adapter against a fake server on a port of its own. `runBlocking`, not `runTest`: the call is real network I/O and its
 * timeouts must be real time.
 */
class GiphyUpstreamTest {

    private val giphy = FakeGiphy()

    @AfterEach
    fun stop() = giphy.close()

    private fun adapterAt(baseUrl: String = giphy.baseUrl): GiphyUpstream {
        val endpoint = mockk<ObjectProvider<UpstreamEndpoint>> { every { getIfAvailable() } returns UpstreamEndpoint(baseUrl) }
        return GiphyUpstream(settings(), endpoint)
    }

    private val adapter = adapterAt()

    private fun gif(id: String, title: String = "T $id", width: String = "480", height: String = "270") =
        """{"type":"gif","id":"$id","url":"https://giphy.com/gifs/$id","title":"$title",""" +
            """"images":{"original":{"width":"$width","height":"$height","url":"https://media.giphy.com/x.gif"},""" +
            """"fixed_height":{"width":"1","height":"1"}},"user":{"username":"someone"}}"""

    private fun answer(status: Int, body: String, vararg headers: Pair<String, String>) {
        giphy.handler = { it.json(status, body, *headers) }
    }

    @Nested
    inner class Request {

        @Test
        fun `when searching then GIPHY gets the key, text, limit, offset, rating and language and nothing else`() = runBlocking {
            adapter.search("happy cat & dog+x?=#%", page = 2, rating = Rating.PG_13, lang = "de")

            val seen = giphy.requests.single()
            assertEquals("GET" to "/v1/gifs/search", seen.method to seen.path, "method and path under the fixed base")
            assertEquals(
                mapOf("api_key" to TEST_KEY, "q" to "happy cat & dog+x?=#%", "limit" to "24", "offset" to "48", "rating" to "pg-13",
                    "lang" to "de"),
                seen.query,
                "the parameters, decoded: special characters of the text arrive as text and cannot add a parameter",
            )
            assertEquals(6, seen.rawQuery.orEmpty().split('&').size, "six parameters, not seven")
        }

        @Test
        fun `when asking for trending then GIPHY gets the key, the limit, the offset and the rating only`() = runBlocking {
            adapter.trending(Rating.G)

            val seen = giphy.requests.single()
            assertEquals("/v1/gifs/trending", seen.path, "path")
            assertEquals(mapOf("api_key" to TEST_KEY, "limit" to "24", "offset" to "0", "rating" to "g"), seen.query, "parameters")
        }

        @Test
        fun `when calling GIPHY then no header of any caller goes along - only Accept and what the HTTP client needs`() = runBlocking {
            adapter.search("cat", 0, Rating.G, "en")

            val headers = giphy.requests.single().headers
            val allowed = setOf("accept", "host", "user-agent", "accept-encoding", "connection", "content-length")
            assertEquals(emptySet(), headers.keys - allowed, "headers sent: ${headers.keys}")
            assertEquals(listOf("application/json"), headers["accept"], "Accept")
        }

        @Test
        fun `when the base address has no trailing slash or has one then the path is the same`() = runBlocking {
            adapterAt(giphy.baseUrl.trimEnd('/')).trending(Rating.G)
            adapterAt(giphy.baseUrl).trending(Rating.G)

            assertEquals(listOf("/v1/gifs/trending", "/v1/gifs/trending"), giphy.requests.map { it.path }, "paths")
        }
    }

    @Nested
    inner class Answer {

        @Test
        fun `when GIPHY answers then only id, title, width, height and the total are taken from it`() = runBlocking {
            answer(
                200,
                """{"data":[${gif("abc123")},${gif("b/2", title = "Odd id", width = "0")}],"pagination":{"total_count":1234,"count":2}}""",
            )

            val page = adapter.search("cat", 0, Rating.G, "en")

            assertEquals(
                listOf(UpstreamGif("abc123", "T abc123", 480, 270), UpstreamGif("b/2", "Odd id", 0, 270)),
                page.entries,
                "the adapter maps, the domain checks (G4): an odd id and a zero width are still entries here",
            )
            assertEquals(1234, page.totalCount, "total_count")
        }

        @Test
        fun `when an entry misses fields or has them in the wrong kind then they are null, not an error`() = runBlocking {
            answer(
                200,
                """{"data":[{"id":5,"title":null,"images":{"original":{"width":"abc","height":270}}},{"images":"x"},"str",null,7]}""",
            )

            val page = adapter.search("cat", 0, Rating.G, "en")

            assertEquals(
                listOf(UpstreamGif(null, null, null, 270)) + List(4) { UpstreamGif(null, null, null, null) },
                page.entries,
                "a number as id is no id; sizes as numbers or strings are read",
            )
            assertNull(page.totalCount, "no pagination")
        }

        @Test
        fun `when GIPHY sends 30 entries then 24 are read`() = runBlocking {
            answer(200, """{"data":[${(1..30).joinToString(",") { gif("g$it") }}],"pagination":{"total_count":99}}""")

            assertEquals(24, adapter.search("cat", 0, Rating.G, "en").entries.size, "a page is 24")
        }

        @Test
        fun `when an empty page comes then it is empty`() = runBlocking {
            assertEquals(emptyList(), adapter.search("cat", 0, Rating.G, "en").entries, "no results")
        }

        @Test
        fun `when the answer is not a page then BAD_RESPONSE`() = runBlocking {
            listOf("", "not json", "{}", """{"data":{}}""", """{"data":"x"}""", "[]", "null").forEach { body ->
                answer(200, body)

                val failure = assertFailsWith<UpstreamFailure>("body '$body'") { adapter.search("cat", 0, Rating.G, "en") }

                assertEquals(UpstreamFailureKind.BAD_RESPONSE, failure.kind, "body '$body'")
            }
        }

        @Test
        fun `when the answer is larger than 2 MB then BAD_RESPONSE, with a Content-Length and without`() = runBlocking {
            val big = """{"data":[],"pad":"${"x".repeat(2 * 1024 * 1024 + 10)}"}"""
            answer(200, big)
            val declared = assertFailsWith<UpstreamFailure>("declared") { adapter.search("cat", 0, Rating.G, "en") }
            giphy.handler = { exchange ->
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, 0) // chunked: no length to look at
                exchange.responseBody.write(big.toByteArray())
            }

            val chunked = assertFailsWith<UpstreamFailure>("chunked") { adapter.search("cat", 0, Rating.G, "en") }

            assertEquals(listOf(UpstreamFailureKind.BAD_RESPONSE, UpstreamFailureKind.BAD_RESPONSE), listOf(declared.kind, chunked.kind),
                "kinds")
        }
    }

    @Nested
    inner class Failures {

        private suspend fun failureOf(status: Int, vararg headers: Pair<String, String>): UpstreamFailure {
            answer(status, """{"message":"the key $TEST_KEY is not valid"}""", *headers)
            return assertFailsWith<UpstreamFailure>("status $status") { adapter.search("cat", 0, Rating.G, "en") }
        }

        @Test
        fun `when GIPHY refuses the key then KEY_REFUSED`() = runBlocking {
            val kinds = listOf(401, 403).map { failureOf(it).kind }

            assertEquals(List(2) { UpstreamFailureKind.KEY_REFUSED }, kinds, "401, 403")
        }

        @Test
        fun `when GIPHY says 429 then RATE_LIMITED with its Retry-After if it sent one`() = runBlocking {
            val with = failureOf(429, "Retry-After" to "42")
            val without = failureOf(429)
            val odd = failureOf(429, "Retry-After" to "Wed, 21 Oct 2026 07:28:00 GMT")

            assertEquals(listOf(42L, null, null), listOf(with, without, odd).map { it.retryAfterSeconds }, "Retry-After")
            assertEquals(List(3) { UpstreamFailureKind.RATE_LIMITED }, listOf(with, without, odd).map { it.kind }, "kinds")
        }

        @Test
        fun `when GIPHY fails then SERVER_ERROR`() = runBlocking {
            assertEquals(List(3) { UpstreamFailureKind.SERVER_ERROR }, listOf(500, 502, 503).map { failureOf(it).kind }, "5xx")
        }

        @Test
        fun `when GIPHY answers another 4xx then BAD_RESPONSE`() = runBlocking {
            assertEquals(List(3) { UpstreamFailureKind.BAD_RESPONSE }, listOf(400, 404, 414).map { failureOf(it).kind }, "4xx")
        }

        @Test
        fun `when GIPHY redirects then the redirect is not followed - the key does not travel on`() = runBlocking {
            val other = FakeGiphy()
            other.use {
                answer(302, "", "Location" to "${other.baseUrl}search")

                val failure = assertFailsWith<UpstreamFailure>("redirect") { adapter.search("cat", 0, Rating.G, "en") }

                assertEquals(UpstreamFailureKind.BAD_RESPONSE, failure.kind, "a 3xx is a failure")
                assertEquals(0, other.requests.size, "nobody asked the other server")
                assertEquals(1, giphy.requests.size, "one request, no second")
            }
        }

        @Test
        fun `when GIPHY does not answer within 5 seconds then TIMEOUT`() = runBlocking {
            giphy.handler = { Thread.sleep(6_000) }

            val started = System.nanoTime()
            val failure = assertFailsWith<UpstreamFailure>("slow") { adapter.search("cat", 0, Rating.G, "en") }
            val seconds = (System.nanoTime() - started) / 1_000_000_000.0

            assertEquals(UpstreamFailureKind.TIMEOUT, failure.kind, "kind")
            assertTrue(seconds in 4.5..5.9, "after about 5 seconds, was $seconds")
        }

        @Test
        fun `when nobody listens at the address then UNREACHABLE`() = runBlocking {
            val dead = FakeGiphy().use { it.baseUrl } // closed again

            val failure = assertFailsWith<UpstreamFailure>("connection refused") { adapterAt(dead).search("cat", 0, Rating.G, "en") }

            assertEquals(UpstreamFailureKind.UNREACHABLE, failure.kind, "kind")
        }

        private suspend fun refused(): UpstreamFailure {
            val dead = FakeGiphy().use { it.baseUrl } // closed again
            return assertFailsWith<UpstreamFailure>("refused") { adapterAt(dead).search("cat", 0, Rating.G, "en") }
        }

        @Test
        fun `when a call fails then the failure has a fixed word, no cause, no stack trace and nothing of the key`() = runBlocking {
            val failures = listOf(
                failureOf(401), failureOf(429, "Retry-After" to "5"), failureOf(500), failureOf(404),
                refused(),
            )

            failures.forEach { failure ->
                val shown = listOf(failure.message, failure.toString(), failure.localizedMessage, failure.stackTraceToString())
                    .joinToString("\n")
                assertEquals(failure.kind.token, failure.message, "the message is the fixed word")
                assertNull(failure.cause, "no cause: the HTTP client's exceptions carry the URI")
                assertContentEquals(emptyArray(), failure.stackTrace, "no stack trace")
                assertTrue(TEST_KEY !in shown && "api_key" !in shown && "127.0.0.1" !in shown && "the key" !in shown,
                    "nothing to leak: $shown")
            }
        }
    }
}
