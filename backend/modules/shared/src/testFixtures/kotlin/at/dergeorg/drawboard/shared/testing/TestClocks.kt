package at.dergeorg.drawboard.shared.testing

import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Instant

/** A fixed point in time for tests that do not care about time passing. */
val FIXED_NOW: Instant = Instant.parse("2026-09-30T08:00:00Z")

/** A clock the test moves forward explicitly - for durations such as "open for 2 hours". */
class MutableClock(private var now: Instant = FIXED_NOW) : Clock {

    fun advanceBy(duration: Duration) {
        now += duration
    }

    override fun now(): Instant = now
}

/** A clock that always says [at]. */
class FixedClock(private val at: Instant = FIXED_NOW) : Clock {
    override fun now(): Instant = at
}
