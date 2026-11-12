package at.dergeorg.drawboard.collab.domain.ratelimit

import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class UserRateLimiterTest {

    private val clock = MutableClock()
    private val limiter = UserRateLimiter(permitsPerMinute = 3, clock = clock)
    private val alice = Uuid.random()
    private val bob = Uuid.random()

    @Test
    fun `when a user takes more than the permits of a minute then 429 with the seconds until the next permit`() {
        repeat(3) { limiter.take(alice) }

        val failure = assertFailsWith<RateLimitedException>("fourth") { limiter.take(alice) }

        assertEquals(60L, failure.retryAfterSeconds, "the permits are refilled together after the minute")
    }

    @Test
    fun `when the minute is over then the user may take again, and another user was never affected`() {
        repeat(3) { limiter.take(alice) }
        repeat(3) { limiter.take(bob) } // its own bucket

        clock.advanceBy(61.seconds)
        repeat(3) { limiter.take(alice) }

        assertFailsWith<RateLimitedException>("the refill is the capacity, not more") { limiter.take(alice) }
    }
}
