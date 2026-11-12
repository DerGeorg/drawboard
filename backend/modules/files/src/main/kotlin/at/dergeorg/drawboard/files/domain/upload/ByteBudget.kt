package at.dergeorg.drawboard.files.domain.upload

import at.dergeorg.drawboard.shared.error.RateLimitedException
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

/**
 * The bytes a user may upload within a window (S7.3: "uploads 30/min/user + bytes"), in memory like the other rate
 * limits. [check] says no (429 with the time until it fits again) once the bytes of the window reach [limit]; [record]
 * adds an upload that went through. So a user can overshoot by the size of one upload (up to the cap of a file), not more.
 */
internal class ByteBudget(private val clock: Clock, private val limit: Long, private val window: Duration = 1.minutes) {

    private val events = ConcurrentHashMap<String, ArrayDeque<Pair<Instant, Long>>>()

    fun check(key: String) {
        val list = events[key] ?: return
        val now = clock.now()
        val wait = synchronized(list) {
            list.removeAll { now - it.first >= window }
            if (list.sumOf { it.second } < limit) return
            val until = list.first().first + window - now
            (until.inWholeMilliseconds + MILLIS - 1) / MILLIS
        }
        throw RateLimitedException(wait.coerceAtLeast(1))
    }

    fun record(key: String, bytes: Long) {
        val now = clock.now()
        val list = events.computeIfAbsent(key) { ArrayDeque() }
        synchronized(list) {
            list.removeAll { now - it.first >= window }
            list.addLast(now to bytes)
        }
        if (events.size > MAX_KEYS) events.entries.removeIf { (_, l) -> synchronized(l) { l.all { now - it.first >= window } } }
    }

    private companion object {
        const val MILLIS = 1000L
        const val MAX_KEYS = 100_000
    }
}
