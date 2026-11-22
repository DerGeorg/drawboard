package at.dergeorg.drawboard.gifs.domain

import at.dergeorg.drawboard.gifs.domain.search.FakeUpstream
import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.RecordingGifsMetrics
import at.dergeorg.drawboard.gifs.domain.search.TEST_KEY
import at.dergeorg.drawboard.gifs.domain.search.entry
import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.gifs.domain.search.model.SearchGifsCommand
import at.dergeorg.drawboard.gifs.domain.search.page
import at.dergeorg.drawboard.gifs.domain.search.requires.RequestOutcome
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailure
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamFailureKind
import at.dergeorg.drawboard.gifs.domain.search.settings
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.RetryAfterException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class GifsServiceTest {

    private val upstream = FakeUpstream()
    private val metrics = RecordingGifsMetrics()
    private val log = RecordingAppLogger()
    private val clock = MutableClock()
    private val alice = Uuid.generateV7()
    private val bob = Uuid.generateV7()

    private fun serviceWith(settings: GifsSettings = settings()) = GifsService(upstream, settings, metrics, log, clock)

    private val service = serviceWith()

    private fun search(q: String = "cat", user: Uuid = alice, page: Int = 0, lang: String? = null) =
        SearchGifsCommand(user, q, page, lang)

    @Nested
    inner class Disabled {

        private val off = serviceWith(settings(apiKey = null))

        @Test
        fun `when there is no key then 404 GIFS_DISABLED for both routes, GIPHY is never called, the outcome is counted`() = runTest {
            val search = assertFailsWith<DomainException>("search") { off.search(search()) }
            val trending = assertFailsWith<DomainException>("trending") { off.trending(alice) }

            assertEquals(listOf(ErrorCode.GIFS_DISABLED, ErrorCode.GIFS_DISABLED), listOf(search.errorCode, trending.errorCode),
                "error codes")
            assertEquals(emptyList(), upstream.calls, "no call to GIPHY without a key (G1)")
            assertEquals(listOf(RequestOutcome.DISABLED, RequestOutcome.DISABLED), metrics.outcomes, "counted as disabled")
        }

        @Test
        fun `when there is no key then disabled comes before validation and the limits - the same answer for any input`() = runTest {
            val error = assertFailsWith<DomainException>("a text that would be invalid") { off.search(search(q = "")) }

            assertEquals(ErrorCode.GIFS_DISABLED, error.errorCode, "G7: disabled is the first check")
        }

        @Test
        fun `when asking whether GIFs are enabled then it follows the key`() {
            assertEquals(false to true, off.isEnabled() to service.isEnabled(), "gifsEnabled = key present (G3)")
        }
    }

    @Nested
    inner class Order {

        @Test
        fun `when the text is too short then 400 and neither the limit of the user nor the cache nor the budget is touched`() = runTest {
            val tight = serviceWith(settings(perMinute = 1))

            repeat(5) { assertFailsWith<ValidationFailedException>("short text") { tight.search(search(q = " a ")) } }
            tight.search(search())

            assertEquals(1, upstream.calls.size, "invalid searches do not count: the valid one still passes the limit of 1 per minute")
        }

        @Test
        fun `when a user is over the limit then 429 even for a cached answer, and the budget is not touched`() = runTest {
            val tight = serviceWith(settings(perMinute = 2))
            tight.search(search())
            tight.search(search()) // cache hit, counts for the user

            val error = assertFailsWith<RateLimitedException>("third request in the minute") { tight.search(search()) }

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, error.errorCode, "error code")
            assertTrue(error.retryAfterSeconds in 1..60,
                "Retry-After is the time until the minute has room again: ${error.retryAfterSeconds}")
            assertEquals(1, upstream.calls.size, "one call to GIPHY for three requests")
            assertEquals(listOf(RequestOutcome.MISS, RequestOutcome.HIT, RequestOutcome.LIMITED_USER), metrics.outcomes, "outcomes")
        }
    }

    @Nested
    inner class UserLimits {

        @Test
        fun `when a user sends 10 requests within a minute then the 11th is 429, another user is not affected`() = runTest {
            repeat(10) { service.search(search(q = "cat$it")) }

            assertFailsWith<RateLimitedException>("11th in the minute") { service.search(search(q = "cat10")) }
            service.search(search(q = "cat11", user = bob))
            assertEquals(11, upstream.calls.size, "ten of alice and one of bob went to GIPHY")
        }

        @Test
        fun `when a minute has passed then the user may search again`() = runTest {
            repeat(10) { service.search(search(q = "cat$it")) }
            assertFailsWith<RateLimitedException>("11th") { service.search(search(q = "cat10")) }

            clock.advanceBy(61.seconds)

            service.search(search(q = "cat10"))
        }

        @Test
        fun `when a user sends 40 requests within an hour then the 41st is 429 although each minute was fine`() = runTest {
            val roomy = serviceWith(settings(budget = 1000))
            repeat(40) {
                roomy.search(search(q = "cat${it % 5}")) // five texts, the rest are cache hits - they count all the same
                clock.advanceBy(80.seconds)
            }

            // 40 requests in 53 minutes, at most one per 80 seconds: the minute is never full
            val error = assertFailsWith<RateLimitedException>("41st within the hour") { roomy.search(search(q = "cat0")) }

            assertTrue(error.retryAfterSeconds > 60, "the hour decides, so the wait is longer than a minute: ${error.retryAfterSeconds}")
            clock.advanceBy(1.hours)
            roomy.search(search(q = "cat0"))
        }

        @Test
        fun `when trending and search are mixed then they share the limit of the user`() = runTest {
            repeat(5) { service.search(search(q = "cat$it")) }
            repeat(5) { service.trending(alice) }

            assertFailsWith<RateLimitedException>("11th call of either kind") { service.trending(alice) }
        }
    }

    @Nested
    inner class Caching {

        @Test
        fun `when the same text comes twice then one call to GIPHY and the second is a hit, with spaces and case ignored`() = runTest {
            val first = service.search(search(q = "Happy  Cat"))
            val second = service.search(search(q = " happy cat "))

            assertEquals(first, second, "the same page")
            assertEquals(1, upstream.calls.size, "one call")
            assertEquals(listOf(RequestOutcome.MISS, RequestOutcome.HIT), metrics.outcomes, "outcomes")
        }

        @Test
        fun `when page or language differ then they are separate calls, and GIPHY gets the normalised text and the rating`() = runTest {
            val pg = serviceWith(settings(rating = Rating.PG))

            pg.search(search(q = "Cat", page = 0))
            pg.search(search(q = "cat", page = 1))
            pg.search(search(q = "cat", page = 1, lang = "de"))

            assertEquals(
                listOf(
                    FakeUpstream.Call("cat", 0, Rating.PG, "en"),
                    FakeUpstream.Call("cat", 1, Rating.PG, "en"),
                    FakeUpstream.Call("cat", 1, Rating.PG, "de"),
                ),
                upstream.calls,
                "text, page, rating and language - nothing of the user",
            )
        }

        @Test
        fun `when 15 minutes have passed then the search is asked again`() = runTest {
            service.search(search())
            clock.advanceBy(14.minutes)
            service.search(search())
            clock.advanceBy(2.minutes)
            service.search(search())

            assertEquals(2, upstream.calls.size, "a hit after 14 minutes, a miss after 16")
        }

        @Test
        fun `when trending is asked again within 30 minutes then it is a hit, after 30 minutes a miss`() = runTest {
            service.trending(alice)
            clock.advanceBy(29.minutes)
            service.trending(alice)
            clock.advanceBy(2.minutes)
            service.trending(alice)

            assertEquals(2, upstream.calls.size, "trending is kept for 30 minutes (G7)")
        }

        @Test
        fun `when there are more than 500 different searches then the cache keeps 500`() = runTest {
            val roomy = serviceWith(settings(budget = 100_000, perMinute = 100_000, perHour = 100_000))
            repeat(600) { roomy.search(search(q = "term$it")) }

            roomy.search(search(q = "term599"))
            roomy.search(search(q = "term0"))

            assertEquals(601, upstream.calls.size, "the newest is still cached, the oldest is gone")
        }

        @Test
        fun `when a hit is served then the budget of the instance is not used`() = runTest {
            val small = serviceWith(settings(budget = 1))

            small.search(search())
            repeat(5) { small.search(search(user = Uuid.generateV7())) }

            assertEquals(1, upstream.calls.size, "five hits, no second call")
            assertEquals(List(5) { RequestOutcome.HIT }, metrics.outcomes.drop(1), "all hits")
        }
    }

    @Nested
    inner class Budget {

        @Test
        fun `when the budget is used up then 429 GIFS_BUDGET_EXHAUSTED, hits still work, after an hour calls work again`() = runTest {
            val small = serviceWith(settings(budget = 2))
            small.search(search(q = "one"))
            small.search(search(q = "two"))

            val error = assertFailsWith<RetryAfterException>("third call to GIPHY") { small.search(search(q = "three", user = bob)) }
            val hit = small.search(search(q = "one", user = bob))
            clock.advanceBy(1.hours + 1.seconds)
            small.search(search(q = "three", user = bob))

            assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, error.errorCode, "error code")
            assertTrue(error.retryAfterSeconds in 1..3601,
                "Retry-After is the time until the oldest call leaves the hour: ${error.retryAfterSeconds}")
            assertEquals(1, hit.items.size, "a cached answer needs no budget")
            assertEquals(3, upstream.calls.size, "two before, one after the hour")
            assertTrue(RequestOutcome.LIMITED_INSTANCE in metrics.outcomes, "counted as limited_instance")
        }

        @Test
        fun `when the budget is used up then the refusal is not remembered - the next call after room returns works at once`() = runTest {
            val small = serviceWith(settings(budget = 1))
            small.search(search(q = "one"))
            assertFailsWith<RetryAfterException>("budget") { small.search(search(q = "two")) }
            assertFailsWith<RetryAfterException>("still") { small.search(search(q = "two")) }

            clock.advanceBy(1.hours + 1.seconds)

            small.search(search(q = "two"))
            assertEquals(2, upstream.calls.size, "refusals did not call GIPHY")
        }
    }

    @Nested
    inner class UpstreamFailures {

        private fun failing(kind: UpstreamFailureKind, retryAfter: Long? = null) {
            upstream.answer = { throw UpstreamFailure(kind, retryAfter) }
        }

        @Test
        fun `when GIPHY refuses the key or fails or times out then 503 GIFS_UNAVAILABLE with Retry-After, never a detail`() = runTest {
            listOf(
                UpstreamFailureKind.KEY_REFUSED, UpstreamFailureKind.SERVER_ERROR, UpstreamFailureKind.TIMEOUT,
                UpstreamFailureKind.UNREACHABLE, UpstreamFailureKind.BAD_RESPONSE,
            ).forEachIndexed { index, kind ->
                failing(kind)

                val error = assertFailsWith<RetryAfterException>("$kind") { service.search(search(q = "cat$index")) }

                assertEquals(ErrorCode.GIFS_UNAVAILABLE, error.errorCode, "$kind: error code")
                assertEquals(30L, error.retryAfterSeconds, "$kind: Retry-After")
            }
            assertEquals(List(5) { RequestOutcome.UPSTREAM_ERROR }, metrics.outcomes, "counted as upstream_error")
        }

        @Test
        fun `when GIPHY says 429 then 429 GIFS_BUDGET_EXHAUSTED with GIPHY's Retry-After, and no other call is made meanwhile`() = runTest {
            failing(UpstreamFailureKind.RATE_LIMITED, retryAfter = 120)

            val error = assertFailsWith<RetryAfterException>("GIPHY 429") { service.search(search(q = "one")) }
            val next = assertFailsWith<RetryAfterException>("another text during the block") { service.search(search(q = "two")) }

            assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, error.errorCode, "error code")
            assertEquals(120L, error.retryAfterSeconds, "GIPHY's own value")
            assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, next.errorCode, "the block is for every text")
            assertEquals(1, upstream.calls.size, "GIPHY was asked once")
            assertEquals(listOf(RequestOutcome.LIMITED_INSTANCE, RequestOutcome.LIMITED_INSTANCE), metrics.outcomes, "outcomes")
        }

        @Test
        fun `when GIPHY says 429 then after the block the calls work again`() = runTest {
            failing(UpstreamFailureKind.RATE_LIMITED, retryAfter = 120)
            assertFailsWith<RetryAfterException>("GIPHY 429") { service.search(search(q = "one")) }
            upstream.answer = { page(entry()) }

            clock.advanceBy(121.seconds)

            assertEquals(1, service.search(search(q = "two")).items.size, "a call after the block")
        }

        @Test
        fun `when GIPHY says 429 without Retry-After or with an absurd one then the block is 60 seconds or at most an hour`() = runTest {
            failing(UpstreamFailureKind.RATE_LIMITED)
            val without = assertFailsWith<RetryAfterException>("no header") { service.search(search(q = "one")) }
            clock.advanceBy(2.minutes)
            failing(UpstreamFailureKind.RATE_LIMITED, retryAfter = 999_999)
            val absurd = assertFailsWith<RetryAfterException>("huge header") { service.search(search(q = "two")) }

            assertEquals(60L to 3600L, without.retryAfterSeconds to absurd.retryAfterSeconds, "defaults and clamp")
        }

        @Test
        fun `when GIPHY failed then the same text is not asked again for 30 seconds, after that it is`() = runTest {
            failing(UpstreamFailureKind.SERVER_ERROR)
            assertFailsWith<RetryAfterException>("first") { service.search(search()) }
            clock.advanceBy(10.seconds)
            val again = assertFailsWith<RetryAfterException>("within 30 seconds") { service.search(search(user = bob)) }
            upstream.answer = { page(entry()) }
            clock.advanceBy(21.seconds)

            val ok = service.search(search(user = bob))

            assertTrue(again.retryAfterSeconds in 1..21, "Retry-After is what is left of the 30 seconds: ${again.retryAfterSeconds}")
            assertEquals(1, ok.items.size, "after the failure left the cache")
            assertEquals(2, upstream.calls.size, "one failed call, one good call")
        }

        @Test
        fun `when GIPHY failed then another text is asked at once, and a failure costs budget like any call`() = runTest {
            val small = serviceWith(settings(budget = 2))
            failing(UpstreamFailureKind.SERVER_ERROR)
            assertFailsWith<RetryAfterException>("one") { small.search(search(q = "one")) }
            upstream.answer = { page(entry()) }
            small.search(search(q = "two"))

            val error = assertFailsWith<RetryAfterException>("budget is gone") { small.search(search(q = "three")) }

            assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, error.errorCode, "the failed call was a call at GIPHY")
        }

        @Test
        fun `when GIPHY fails then the log holds the fixed word and nothing of the key, the text or the user`() = runTest {
            failing(UpstreamFailureKind.KEY_REFUSED)

            assertFailsWith<RetryAfterException>("refused") { service.search(search(q = "my private search")) }

            val lines = log.entries.joinToString("\n") { "${it.level} ${it.message} ${it.fields} ${it.cause}" }
            assertEquals(1, log.entries.size, "one line per failed call")
            assertTrue("key_refused" in lines, "the fixed word: $lines")
            assertTrue(listOf(TEST_KEY, "private", alice.toString()).none { it in lines }, "nothing private in the log: $lines")
        }

        @Test
        fun `when nothing fails then the service writes no log line at all`() = runTest {
            service.search(search(q = "my private search"))
            service.trending(alice)

            assertEquals(emptyList(), log.entries, "a search is not an event worth a line (G8)")
        }
    }

    @Nested
    inner class SingleFlight {

        @Test
        fun `when equal searches come at the same time then GIPHY is asked once and everybody gets the answer`() = runTest {
            val gate = CompletableDeferred<Unit>()
            upstream.answer = { gate.await(); page(entry("shared1")) }

            val first = async { service.search(search(user = alice)) }
            val second = async { service.search(search(user = bob)) }
            val third = async { service.search(search(q = " CAT ", user = Uuid.generateV7())) }
            runCurrent()
            assertEquals(1, upstream.calls.size, "one call under way, two waiting")
            gate.complete(Unit)

            assertEquals(List(3) { "shared1" }, listOf(first, second, third).map { it.await().items.single().id },
                "the same answer for all")
            assertEquals(1, upstream.calls.size, "still one call")
            val counted = metrics.outcomes.groupingBy { it }.eachCount()
            assertEquals(mapOf(RequestOutcome.MISS to 1, RequestOutcome.HIT to 2), counted, "one miss, two hits")
        }

        @Test
        fun `when the one who asks GIPHY gives up then a waiting caller asks itself`() = runTest {
            val gate = CompletableDeferred<Unit>()
            upstream.answer = { gate.await(); page(entry("later1")) }
            val leader = async { service.search(search(user = alice)) }
            runCurrent()
            val waiting = async { service.search(search(user = bob)) }
            runCurrent()

            leader.cancel()
            runCurrent()
            gate.complete(Unit)

            assertEquals("later1", waiting.await().items.single().id, "the waiting caller got an answer of its own")
            assertEquals(2, upstream.calls.size, "the cancelled call and the new one")
        }

        @Test
        fun `when equal searches fail at the same time then every caller gets the failure from one call`() = runTest {
            val gate = CompletableDeferred<Unit>()
            upstream.answer = { gate.await(); throw UpstreamFailure(UpstreamFailureKind.TIMEOUT) }
            val calls = listOf(alice, bob).map { user -> async { runCatching { service.search(search(user = user)) } } }
            runCurrent()
            gate.complete(Unit)

            val errors = calls.map { assertNotNull(it.await().exceptionOrNull(), "a failure") }

            assertEquals(listOf(ErrorCode.GIFS_UNAVAILABLE, ErrorCode.GIFS_UNAVAILABLE), errors.map { (it as DomainException).errorCode },
                "codes")
            assertEquals(1, upstream.calls.size, "one call")
        }
    }

    @Nested
    inner class Trending {

        @Test
        fun `when listing trending then GIPHY gets the rating only and the answer has no more pages`() = runTest {
            upstream.answer = { page(*Array(24) { entry("id$it") }, total = 5000) }
            val pg13 = serviceWith(settings(rating = Rating.PG_13))

            val results = pg13.trending(alice)

            assertEquals(listOf(FakeUpstream.Call(null, 0, Rating.PG_13, null)), upstream.calls, "no text, no language, no user")
            assertEquals(24 to false, results.items.size to results.hasMore, "24 GIFs, hasMore false")
        }
    }
}
