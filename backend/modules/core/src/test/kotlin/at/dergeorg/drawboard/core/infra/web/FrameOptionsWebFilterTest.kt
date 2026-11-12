package at.dergeorg.drawboard.core.infra.web

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.mock.http.server.reactive.MockServerHttpRequest
import org.springframework.mock.web.server.MockServerWebExchange
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FrameOptionsWebFilterTest {

    private val base = "/plugin-assets/org.example.timer/1.0.0/" + "a".repeat(64)

    private fun headerFor(path: String): String? {
        val exchange = MockServerWebExchange.from(MockServerHttpRequest.get(path))
        FrameOptionsWebFilter().filter(exchange) { it.response.setComplete() }.block()
        return exchange.response.headers.getFirst(FrameOptionsWebFilter.HEADER)
    }

    @Nested
    inner class Exemption {

        @Test
        fun `when the path is the generated frame document of a plugin then it may be framed`() {
            assertTrue(FrameOptionsWebFilter.isFrameDocument("$base/__drawboard/frame.html"), "the frame document")
            assertNull(headerFor("$base/__drawboard/frame.html"), "no X-Frame-Options: frame-ancestors of its CSP says who")
        }

        @Test
        fun `when the path is a script, a style or any other file of a plugin bundle then DENY`() {
            listOf("$base/dist/index.js", "$base/style.css", "$base/img/logo.png", "$base/frame.html", "$base/dist/__drawboard/frame.html")
                .forEach { assertEquals("DENY", headerFor(it), "DENY for $it") }
        }

        @Test
        fun `when the path only looks like the frame document then DENY`() {
            listOf(
                "/plugin-assets/__drawboard/frame.html",
                "/plugin-assets/org.example.timer/1.0.0/__drawboard/frame.html",
                "/api/boards/b/__drawboard/frame.html",
                "/other/org.example.timer/1.0.0/${"a".repeat(64)}/__drawboard/frame.html",
                "$base/__drawboard/frame.html/",
                "$base/__drawboard/frame.htmlx",
            ).forEach {
                assertFalse(FrameOptionsWebFilter.isFrameDocument(it), "not the frame: $it")
                assertEquals("DENY", headerFor(it), "DENY for $it")
            }
        }

        @Test
        fun `when the response is the API or a file then DENY`() {
            assertEquals("DENY", headerFor("/api/boards"), "api")
            assertEquals("DENY", headerFor("/files/abc"), "files")
        }
    }
}
