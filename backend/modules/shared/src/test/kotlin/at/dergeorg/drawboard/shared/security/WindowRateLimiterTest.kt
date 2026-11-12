package at.dergeorg.drawboard.shared.security

import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class WindowRateLimiterTest {

    private val clock = MutableClock()

    @Test
    fun `when taking up to the limit then all pass and the next one is refused with a Retry-After`() {
        val limiter = WindowRateLimiter(clock, RateRule(3, 1.minutes))

        repeat(3) { limiter.take("k") }
        val refused = assertFailsWith<RateLimitedException>("fourth call in the minute") { limiter.take("k") }

        assertTrue(refused.retryAfterSeconds in 1..60, "retry after is within the window, was ${refused.retryAfterSeconds}")
    }

    @Test
    fun `when the window has passed then the key may try again`() {
        val limiter = WindowRateLimiter(clock, RateRule(2, 1.minutes))
        repeat(2) { limiter.take("k") }

        clock.advanceBy(61.seconds)

        limiter.take("k")
    }

    @Test
    fun `when two keys are used then they are counted apart`() {
        val limiter = WindowRateLimiter(clock, RateRule(1, 1.minutes))

        limiter.take("a")
        limiter.take("b")

        assertFailsWith<RateLimitedException>("a is used up") { limiter.take("a") }
    }

    @Test
    fun `when failures keep coming while blocked then the delay grows but is never forever`() {
        val limiter = WindowRateLimiter(clock, RateRule(5, 1.minutes), RateRule(20, 1.hours))
        repeat(5) { limiter.record("share") }
        val first = limiter.retryAfterSeconds("share")

        repeat(4) { limiter.record("share") }
        val later = limiter.retryAfterSeconds("share")
        clock.advanceBy(2.hours)

        assertTrue(later > first, "more attempts while blocked: longer delay ($first -> $later)")
        assertEquals(0, limiter.retryAfterSeconds("share"), "old failures leave the window: never locked for good")
    }

    @Test
    fun `when a second rule is longer then it blocks after the short one has passed`() {
        val limiter = WindowRateLimiter(clock, RateRule(5, 1.minutes), RateRule(7, 1.hours))
        repeat(7) {
            limiter.record("k")
            clock.advanceBy(61.seconds)
        }

        assertTrue(limiter.retryAfterSeconds("k") > 0, "seven failures within the hour block although none is younger than a minute")
    }

    @Test
    fun `when only checking then nothing is recorded`() {
        val limiter = WindowRateLimiter(clock, RateRule(1, 1.minutes))

        repeat(10) { limiter.check("k") }
    }

    @Test
    fun `when the key map grows beyond its bound then idle keys are dropped at once and the map stays bounded`() {
        val limiter = WindowRateLimiter(clock, RateRule(1, 1.minutes))
        repeat(100_000) { limiter.record("k$it") }
        clock.advanceBy(2.minutes)

        repeat(10) { limiter.record("fresh$it") }

        assertEquals(0L, limiter.retryAfterSeconds("k5"), "the idle key was dropped")
        assertTrue(limiter.retryAfterSeconds("fresh3") > 0, "a fresh key is still counted")
    }

    @Test
    fun `when even fresh keys fill the map then it does not grow past the bound`() {
        val limiter = WindowRateLimiter(clock, RateRule(1, 1.hours))
        repeat(100_050) { limiter.record("k$it") }

        assertTrue(limiter.retryAfterSeconds("k100049") > 0, "the newest key is counted")
    }
}
