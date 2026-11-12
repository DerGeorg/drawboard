package at.dergeorg.drawboard.core.infra

import kotlin.time.Clock
import kotlin.time.Instant

/**
 * The system clock, cut to whole microseconds - the precision of PostgreSQL's `timestamp`. On Linux the system clock
 * has nanoseconds: the response to POST would then carry 10:22:20.969182505Z, and a later GET the stored
 * 10:22:20.969183Z (green on the Mac, red in the pipeline).
 */
internal object MicrosecondClock : Clock {
    override fun now(): Instant {
        val now = Clock.System.now()
        return Instant.fromEpochSeconds(now.epochSeconds, now.nanosecondsOfSecond / NANOS_PER_MICRO * NANOS_PER_MICRO)
    }

    private const val NANOS_PER_MICRO = 1_000
}
