package at.dergeorg.drawboard.files.domain.upload

import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Duration.Companion.seconds

class UploadHelpersTest {

    @Nested
    inner class Names {

        @Test
        fun `when the name carries a path then only the last part is kept`() {
            assertEquals("passwd", FileNames.sanitise("../../etc/passwd"), "unix path")
            assertEquals("evil.png", FileNames.sanitise("C:\\Users\\x\\evil.png"), "windows path")
        }

        @Test
        fun `when the name has control, direction or quote characters then they are removed`() {
            assertEquals("fileexe.png", FileNames.sanitise("file\u202Eexe.png"), "right-to-left override")
            assertEquals("ab.png", FileNames.sanitise("a\u0000b\n.png"), "controls")
            assertEquals("a.png", FileNames.sanitise("\"a.png\""), "quotes would break the header")
        }

        @Test
        fun `when the name is empty then there is a fallback and a long name keeps its extension`() {
            assertEquals("file", FileNames.sanitise(null), "null")
            assertEquals("file", FileNames.sanitise("  ../ "), "nothing left")
            val long = FileNames.sanitise("a".repeat(400) + ".pdf")
            assertEquals(255, long.length, "cut to 255")
            assertEquals(true, long.endsWith(".pdf"), "the extension survives, so the type check still sees it")
        }
    }

    @Nested
    inner class Budget {

        private val clock = MutableClock()
        private val limiter = ByteBudget(clock, limit = 1000)

        @Test
        fun `when a user used the bytes of the window then the next upload is a 429 until the window moves`() {
            limiter.check("u")
            limiter.record("u", 1000)

            val failure = assertFailsWith<RateLimitedException>("budget used up") { limiter.check("u") }
            assertEquals(true, failure.retryAfterSeconds in 1..60, "retry-after is the rest of the window")
            clock.advanceBy(61.seconds)
            limiter.check("u")
        }

        @Test
        fun `when another user uploads then the budget of the first is untouched`() {
            limiter.record("u", 5000)

            limiter.check("other")
        }
    }
}
