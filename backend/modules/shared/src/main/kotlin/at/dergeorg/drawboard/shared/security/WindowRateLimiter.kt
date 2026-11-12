package at.dergeorg.drawboard.shared.security

import at.dergeorg.drawboard.shared.error.RateLimitedException
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

/** At most [max] events within [window]. */
data class RateRule(val max: Int, val window: Duration) {
    init {
        require(max >= 1 && window.isPositive()) { "a rate rule needs a positive limit and window" }
    }
}

/**
 * A sliding-window counter per key, in memory (one replica, like the rest), driven by the application clock so tests
 * move the limit with the clock. Two ways to use it:
 *
 * * [take] - "at most N calls": records the call and answers 429 ([RateLimitedException]) when the key is over a rule;
 * * [check] + [record] - "at most N failures": [check] throws while the key is blocked, [record] counts a failure. Call
 *   [record] for failures that happen while blocked, too: the delay grows with every further attempt (S1.11), the
 *   share is never locked for good because old events leave the window.
 *
 * The delay in `Retry-After` is the time until the key is under every rule again, plus a growing extra for events
 * beyond the limit (1, 3, 7, ... seconds, at most [MAX_EXTRA_SECONDS]).
 */
class WindowRateLimiter(private val clock: Clock, private val rules: List<RateRule>) {

    constructor(clock: Clock, vararg rules: RateRule) : this(clock, rules.toList())

    private val events = ConcurrentHashMap<String, ArrayDeque<Instant>>()

    @Volatile
    private var lastPurge: Instant = Instant.DISTANT_PAST

    /** Records one event and throws if the key is over a rule afterwards or was already blocked. */
    fun take(key: String) {
        check(key)
        record(key)
    }

    /** Throws [RateLimitedException] while [key] is over a rule. Records nothing. */
    fun check(key: String) {
        val wait = retryAfterSeconds(key)
        if (wait > 0) throw RateLimitedException(wait)
    }

    /** Counts one event for [key]. */
    fun record(key: String) {
        val now = clock.now()
        purge(now)
        if (events.size >= MAX_KEYS && !events.containsKey(key)) makeRoom(now)
        val list = events.computeIfAbsent(key) { ArrayDeque() }
        synchronized(list) { list.addLast(now) }
    }

    /** Seconds until [key] may try again, 0 if it may now. */
    fun retryAfterSeconds(key: String): Long {
        val list = events[key] ?: return 0
        val now = clock.now()
        return synchronized(list) {
            list.removeAll { now - it >= longest }
            rules.maxOf { rule -> waitFor(list, rule, now) }
        }
    }

    private fun waitFor(list: List<Instant>, rule: RateRule, now: Instant): Long {
        val inWindow = list.filter { now - it < rule.window }
        if (inWindow.size < rule.max) return 0
        // The window must lose the events beyond (max - 1) before one more fits.
        val mustLeave = inWindow.size - rule.max + 1
        val until = inWindow.sorted()[mustLeave - 1] + rule.window - now
        val excess = (inWindow.size - rule.max).coerceAtMost(EXTRA_EXPONENT_CAP)
        val extra = ((1L shl excess) - 1).coerceAtMost(MAX_EXTRA_SECONDS)
        return (until.inWholeMilliseconds + MILLIS - 1) / MILLIS + extra
    }

    private val longest: Duration get() = rules.maxOf { it.window }

    /** Above [MAX_KEYS] keys: drop the idle ones at once; if that is not enough, arbitrary ones (a reset beats an out-of-memory). */
    private fun makeRoom(now: Instant) {
        lastPurge = now
        events.entries.removeIf { (_, list) -> synchronized(list) { list.all { now - it >= longest } } }
        val surplus = events.size - MAX_KEYS + 1
        if (surplus > 0) events.keys.take(surplus).forEach(events::remove)
    }

    private fun purge(now: Instant) {
        if (now - lastPurge < PURGE_EVERY) return
        lastPurge = now
        events.entries.removeIf { (_, list) -> synchronized(list) { list.all { now - it >= longest } } }
    }

    private companion object {
        val PURGE_EVERY = 60.seconds
        const val MILLIS = 1000L
        const val MAX_KEYS = 100_000
        const val MAX_EXTRA_SECONDS = 600L
        const val EXTRA_EXPONENT_CAP = 10
    }
}
