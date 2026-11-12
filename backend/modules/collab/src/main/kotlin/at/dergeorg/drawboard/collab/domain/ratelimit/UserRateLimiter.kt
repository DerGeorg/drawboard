// Bucket4j's API takes java.time.Duration: one of the few places outside the converters of core that has to name it.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.collab.domain.ratelimit

import at.dergeorg.drawboard.shared.error.RateLimitedException
import io.github.bucket4j.Bandwidth
import io.github.bucket4j.Bucket
import io.github.bucket4j.TimeMeter
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * At most [permitsPerMinute] calls per user and minute (Bucket4j, in memory, one replica like the rest of collab).
 * [take] throws [RateLimitedException] (429 with `Retry-After`) when the user is out of permits. The time is the
 * application clock, so tests that move the clock move the limit with it. Idle buckets are dropped now and then.
 */
internal class UserRateLimiter(private val permitsPerMinute: Long, private val clock: Clock) {

    private class UserBucket(val bucket: Bucket) {
        @Volatile
        var lastUsedNanos: Long = 0
    }

    private val buckets = ConcurrentHashMap<Uuid, UserBucket>()

    @Volatile
    private var lastPurge: Instant = Instant.DISTANT_PAST

    private val meter = object : TimeMeter {
        override fun currentTimeNanos(): Long = clock.now().let { it.epochSeconds * NANOS + it.nanosecondsOfSecond }

        override fun isWallClockBased(): Boolean = true
    }

    fun take(userId: Uuid) {
        purge(clock.now())
        val userBucket = buckets.computeIfAbsent(userId) { UserBucket(newBucket()) }
        userBucket.lastUsedNanos = meter.currentTimeNanos()
        val probe = userBucket.bucket.tryConsumeAndReturnRemaining(1)
        if (!probe.isConsumed) {
            throw RateLimitedException(retryAfterSeconds = ((probe.nanosToWaitForRefill + NANOS - 1) / NANOS).coerceAtLeast(1))
        }
    }

    private fun purge(now: Instant) {
        if (now - lastPurge < PURGE_SECONDS.seconds) return
        lastPurge = now
        val idleBefore = meter.currentTimeNanos() - IDLE_BUCKET_SECONDS * NANOS
        buckets.values.removeIf { it.lastUsedNanos < idleBefore }
    }

    private fun newBucket(): Bucket = Bucket.builder()
        .addLimit(Bandwidth.builder().capacity(permitsPerMinute).refillIntervally(permitsPerMinute, Duration.ofMinutes(1)).build())
        .withCustomTimePrecision(meter)
        .build()

    private companion object {
        const val NANOS = 1_000_000_000L
        const val PURGE_SECONDS = 30L
        const val IDLE_BUCKET_SECONDS = 120L
    }
}
