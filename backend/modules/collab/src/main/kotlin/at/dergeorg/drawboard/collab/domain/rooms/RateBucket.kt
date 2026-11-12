package at.dergeorg.drawboard.collab.domain.rooms

import kotlin.time.Instant

/**
 * Token bucket for the messages of ONE session: [perSecond] sustained, [burst] at once (S2.5). Not thread-safe on
 * purpose - the frames of a session are handled one after the other.
 */
internal class RateBucket(private val perSecond: Int, private val burst: Int, start: Instant) {
    private var tokens = burst.toDouble()
    private var last = start

    /** Takes one token; false = the session is above its limit. */
    fun tryTake(now: Instant): Boolean {
        val elapsedSeconds = (now - last).inWholeNanoseconds / NANOS_PER_SECOND
        tokens = minOf(burst.toDouble(), tokens + elapsedSeconds * perSecond)
        last = now
        if (tokens < 1.0) return false
        tokens -= 1.0
        return true
    }

    private companion object {
        const val NANOS_PER_SECOND = 1_000_000_000.0
    }
}
