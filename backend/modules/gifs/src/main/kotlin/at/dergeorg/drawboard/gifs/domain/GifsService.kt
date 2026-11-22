package at.dergeorg.drawboard.gifs.domain

import at.dergeorg.drawboard.gifs.domain.search.CacheKey
import at.dergeorg.drawboard.gifs.domain.search.GifCache
import at.dergeorg.drawboard.gifs.domain.search.GifRules
import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.model.GifResults
import at.dergeorg.drawboard.gifs.domain.search.model.SearchGifsCommand
import at.dergeorg.drawboard.gifs.domain.search.provides.GifSearchUseCase
import at.dergeorg.drawboard.gifs.domain.search.requires.GifUpstream
import at.dergeorg.drawboard.gifs.domain.search.requires.GifsMetrics
import at.dergeorg.drawboard.gifs.domain.search.requires.RequestOutcome
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailure
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailureKind
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.RetryAfterException
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.CompletableDeferred
import org.springframework.stereotype.Service
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements GIF search (3.14, decisions G1-G16). The order of the checks is the one of G7 and does not change: disabled, validation,
 * the limits of the user (a cache hit counts), the cache, the budget of the instance (a call to GIPHY counts), GIPHY.
 *
 * * Equal searches at the same time share one call to GIPHY (single flight): the first caller asks, the others wait for its answer.
 * * A failure of GIPHY is kept for 30 seconds, so a key that GIPHY refuses is not asked again for every request.
 * * Search texts live in the cache keys and in the call to GIPHY, nowhere else: no log line, span attribute, metric label or
 *   audit event of this class has one (G8), and the key is not known here at all (G2).
 */
@Service
internal class GifsService(
    private val upstream: GifUpstream,
    private val settings: GifsSettings,
    private val metrics: GifsMetrics,
    private val log: AppLogger,
    private val clock: Clock,
) : GifSearchUseCase {

    private sealed interface Outcome {
        class Found(val results: GifResults) : Outcome

        /** [retryUntil]: what the caller is told to wait for (`Retry-After`). */
        class Failed(val code: ErrorCode, val retryUntil: Instant, val label: RequestOutcome) : Outcome

        /** The caller that asked GIPHY was cancelled before it had an answer: whoever waited for it asks again. */
        data object Abandoned : Outcome
    }

    private val users = WindowRateLimiter(clock, RateRule(settings.userPerMinute, 1.minutes), RateRule(settings.userPerHour, settings.hour))
    private val budget = WindowRateLimiter(clock, RateRule(settings.hourlyBudget, settings.hour))
    private val budgetLock = Any()
    private var blockedUntil: Instant = Instant.DISTANT_PAST // GIPHY said 429: no call before this time; guarded by budgetLock
    private val cache = GifCache<Outcome>(clock, settings.cacheEntries)
    private val inFlight = ConcurrentHashMap<CacheKey, CompletableDeferred<Outcome>>()

    @WithSpan
    override fun isEnabled(): Boolean = settings.enabled

    @WithSpan
    override fun requireEnabled() {
        if (settings.enabled) return
        metrics.request(RequestOutcome.DISABLED)
        throw DomainException(ErrorCode.GIFS_DISABLED)
    }

    @WithSpan
    override suspend fun search(command: SearchGifsCommand): GifResults {
        requireEnabled()
        val term = GifRules.term(command.q)
        val lang = GifRules.lang(command.lang)
        val page = GifRules.page(command.page)
        takeUser(command.userId)
        val key = CacheKey(trending = false, term = term, page = page, rating = settings.rating, lang = lang)
        return resolve(key, settings.searchTtl) { GifRules.results(upstream.search(term, page, settings.rating, lang), page) }
    }

    @WithSpan
    override suspend fun trending(userId: Uuid): GifResults {
        requireEnabled()
        takeUser(userId)
        val key = CacheKey(trending = true, term = "", page = 0, rating = settings.rating, lang = "")
        return resolve(key, settings.trendingTtl) { GifRules.results(upstream.trending(settings.rating), page = null) }
    }

    /** 10 per minute and 40 per hour, for every request that passed the validation, a cache hit included (G7). */
    private fun takeUser(userId: Uuid) {
        try {
            users.take(userId.toString())
        } catch (e: RateLimitedException) {
            metrics.request(RequestOutcome.LIMITED_USER)
            throw e
        }
    }

    /** The answer for [key] from the cache, from a call that is under way, or from a call of its own. */
    private suspend fun resolve(key: CacheKey, ttl: Duration, load: suspend () -> GifResults): GifResults {
        while (true) {
            cache.get(key)?.let { return settle(it, fresh = false) }
            val mine = CompletableDeferred<Outcome>()
            val running = inFlight.putIfAbsent(key, mine)
            if (running != null) {
                val outcome = running.await()
                if (outcome !== Outcome.Abandoned) return settle(outcome, fresh = false)
                continue
            }
            var outcome: Outcome = Outcome.Abandoned
            var fresh = false
            try {
                val cached = cache.get(key) // somebody finished between the first look and the registration
                fresh = cached == null
                outcome = cached ?: lead(key, ttl, load)
            } finally {
                inFlight.remove(key, mine)
                mine.complete(outcome)
            }
            return settle(outcome, fresh)
        }
    }

    /** Counts the request and hands over the results, or throws what the caller is to see. */
    private fun settle(outcome: Outcome, fresh: Boolean): GifResults = when (outcome) {
        is Outcome.Found -> {
            metrics.request(if (fresh) RequestOutcome.MISS else RequestOutcome.HIT)
            outcome.results
        }
        is Outcome.Failed -> {
            metrics.request(outcome.label)
            throw RetryAfterException(outcome.code, secondsUntil(outcome.retryUntil))
        }
        Outcome.Abandoned -> error("an abandoned call is never handed to a caller")
    }

    /** Takes one call of the budget and asks GIPHY. Only here does a call to GIPHY happen. */
    private suspend fun lead(key: CacheKey, ttl: Duration, load: suspend () -> GifResults): Outcome {
        reserveBudget()?.let { return it }
        return try {
            Outcome.Found(load()).also { cache.put(key, it, ttl) }
        } catch (e: UpstreamFailure) {
            failed(e).also { cache.put(key, it, settings.failureTtl) }
        }
    }

    /** One call of the hourly budget of the instance (G7), or why there is none: used up, or GIPHY itself said 429 a moment ago. */
    private fun reserveBudget(): Outcome.Failed? = synchronized(budgetLock) {
        val now = clock.now()
        if (blockedUntil > now) return exhausted(blockedUntil)
        val wait = budget.retryAfterSeconds(INSTANCE)
        if (wait > 0) return exhausted(now + wait.seconds)
        budget.record(INSTANCE)
        null
    }

    private fun exhausted(until: Instant) = Outcome.Failed(ErrorCode.GIFS_BUDGET_EXHAUSTED, until, RequestOutcome.LIMITED_INSTANCE)

    /** GIPHY's 429 is the budget of the instance, as far as the caller is concerned; everything else is "unavailable". */
    private fun failed(failure: UpstreamFailure): Outcome.Failed {
        log.warn("GIPHY call failed", "gifs.upstream.outcome" to failure.kind.token)
        val now = clock.now()
        if (failure.kind != UpstreamFailureKind.RATE_LIMITED) {
            return Outcome.Failed(ErrorCode.GIFS_UNAVAILABLE, now + settings.failureTtl, RequestOutcome.UPSTREAM_ERROR)
        }
        val until = now + (failure.retryAfterSeconds ?: DEFAULT_BLOCK_SECONDS).coerceIn(1, MAX_BLOCK_SECONDS).seconds
        synchronized(budgetLock) { if (until > blockedUntil) blockedUntil = until }
        return exhausted(until)
    }

    /** Whole seconds, rounded up, at least 1: what `Retry-After` says. */
    private fun secondsUntil(time: Instant): Long = ((time - clock.now()).inWholeMilliseconds + MILLIS - 1).div(MILLIS).coerceAtLeast(1)

    private companion object {
        const val INSTANCE = "instance"
        const val MILLIS = 1000L
        const val DEFAULT_BLOCK_SECONDS = 60L
        const val MAX_BLOCK_SECONDS = 3600L
    }
}
