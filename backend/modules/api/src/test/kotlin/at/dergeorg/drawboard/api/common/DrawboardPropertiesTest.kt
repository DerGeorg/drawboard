package at.dergeorg.drawboard.api.common

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DrawboardPropertiesTest {

    @Test
    fun `when the public URL is empty or blank then startup fails`() {
        assertFailsWith<IllegalArgumentException>("empty") { DrawboardProperties(publicUrl = "") }
        assertFailsWith<IllegalArgumentException>("blank") { DrawboardProperties(publicUrl = "  ") }
    }

    @Test
    fun `when comparing with an Origin header then a trailing slash is ignored and nothing else`() {
        assertEquals("https://drawboard.example.org", DrawboardProperties("https://drawboard.example.org/").origin, "trailing slash")
        assertEquals("http://localhost:4200", DrawboardProperties(" http://localhost:4200 ").origin, "surrounding blanks")
    }

    @Test
    fun `when the public URL is an origin then scheme and host are lower case and the port is kept`() {
        assertEquals("https://drawboard.example.org", DrawboardProperties("HTTPS://Drawboard.Example.org").origin, "case")
        assertEquals("https://drawboard.example.org:8443", DrawboardProperties("https://drawboard.example.org:8443/").origin, "port")
        assertEquals("http://[::1]:4200", DrawboardProperties("http://[::1]:4200").origin, "IPv6")
    }

    @Test
    fun `when the public URL names the default port then it is left out like browsers do in Origin`() {
        assertEquals("https://board.example.org", DrawboardProperties("https://board.example.org:443").origin, "https 443")
        assertEquals("http://localhost", DrawboardProperties("http://localhost:80").origin, "http 80")
        assertEquals("https://board.example.org:8443", DrawboardProperties("https://board.example.org:8443").origin, "other port kept")
    }

    @Test
    fun `when the public URL is not an origin then startup fails with a message that names the problem`() {
        val cases = mapOf(
            "drawboard.example.org" to "http:// or https://",
            "ftp://drawboard.example.org" to "http:// or https://",
            "javascript:alert(1)" to "http:// or https://",
            "https://" to "valid URL",
            "https:///path" to "host",
            "https://user:secret@drawboard.example.org" to "user info",
            "https://drawboard.example.org/app" to "path",
            "https://drawboard.example.org//" to "path",
            "https://drawboard.example.org?x=1" to "query",
            "https://drawboard.example.org/#top" to "fragment",
            "https://drawboard.example.org:99999" to "port",
            "https://drawboard .example.org" to "valid URL",
        )
        for ((value, problem) in cases) {
            val failure = assertFailsWith<IllegalArgumentException>("rejects $value") { DrawboardProperties(value) }
            assertEquals(true, failure.message?.contains(problem), "the message for $value mentions '$problem': ${failure.message}")
        }
    }
}
