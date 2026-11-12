package at.dergeorg.drawboard.core.infra.web

import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.minutes

class UploadGuardTest {

    private val clock = MutableClock()
    private val limits = UploadProperties(
        maxFileBytes = 1000, maxSnapshotBytes = 100, maxPluginBytes = 10, envelopeBytes = 5,
        perUserConcurrent = 2, perUserPerMinute = 3, globalConcurrent = 3,
    )
    private val guard = UploadGuard(limits, clock)

    @Nested
    inner class Routes {

        @Test
        fun `when the method and path of an upload route match then the route is found`() {
            assertEquals(UploadRoute.FILE, UploadRoute.of(HttpMethod.POST, "/api/boards/b1/files"), "uploadFile")
            assertEquals(UploadRoute.SNAPSHOT, UploadRoute.of(HttpMethod.PUT, "/api/boards/b1/snapshot"), "uploadBoardSnapshot")
            assertEquals(UploadRoute.PLUGIN, UploadRoute.of(HttpMethod.POST, "/api/admin/plugins"), "installPlugin")
        }

        @Test
        fun `when the method or path is another one then no route is found`() {
            assertNull(UploadRoute.of(HttpMethod.GET, "/api/boards/b1/files"), "list is not an upload")
            assertNull(UploadRoute.of(HttpMethod.POST, "/api/boards/b1/files/f1"), "one segment too many")
            assertNull(UploadRoute.of(HttpMethod.POST, "/api/boards/files"), "one segment too few")
            assertNull(UploadRoute.of(HttpMethod.PUT, "/api/admin/plugins/org.example"), "plugin update takes JSON")
            assertNull(UploadRoute.of(HttpMethod.PUT, "/api/boards/b1/files"), "wrong method")
        }
    }

    @Nested
    inner class Length {

        @Test
        fun `when there is no Content-Length or the body is chunked then 411`() {
            val missing = assertFailsWith<ResponseStatusException>("no length") { guard.admit(UploadRoute.FILE, "u", -1, chunked = false) }
            val chunked = assertFailsWith<ResponseStatusException>("chunked") { guard.admit(UploadRoute.FILE, "u", 10, chunked = true) }

            assertEquals(HttpStatus.LENGTH_REQUIRED, missing.statusCode, "missing")
            assertEquals(HttpStatus.LENGTH_REQUIRED, chunked.statusCode, "chunked, whatever length it claims")
            assertEquals(0, guard.inFlight, "nothing is held")
        }

        @Test
        fun `when the length is above the cap of the route plus the envelope then 413 with the cap, at the cap it passes`() {
            assertFailsWith<PayloadTooLargeException>("snapshot") { guard.admit(UploadRoute.SNAPSHOT, "u", 106, chunked = false) }
            val plugin = assertFailsWith<PayloadTooLargeException>("plugin") { guard.admit(UploadRoute.PLUGIN, "u", 16, chunked = false) }
            guard.admit(UploadRoute.SNAPSHOT, "u", 105, chunked = false).close()
            guard.admit(UploadRoute.FILE, "u", 1005, chunked = false).close()

            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, plugin.errorCode, "the existing code")
            assertEquals("10", plugin.params["limit"], "the cap of the route as the handler sees it, without the envelope")
        }
    }

    @Nested
    inner class Concurrency {

        @Test
        fun `when a user has two uploads in flight then the third is refused with 429 until one ends`() {
            val first = guard.admit(UploadRoute.FILE, "alice", 1, chunked = false)
            guard.admit(UploadRoute.SNAPSHOT, "alice", 1, chunked = false)

            val third = assertFailsWith<RateLimitedException>("third") { guard.admit(UploadRoute.PLUGIN, "alice", 1, chunked = false) }
            first.close()
            guard.admit(UploadRoute.PLUGIN, "alice", 1, chunked = false)

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, third.errorCode, "the existing 429 code")
            assertEquals(2, guard.inFlight, "the refused one holds nothing")
        }

        @Test
        fun `when a slot is closed twice then it frees one place only`() {
            val slot = guard.admit(UploadRoute.FILE, "alice", 1, chunked = false)
            guard.admit(UploadRoute.FILE, "alice", 1, chunked = false)

            slot.close()
            slot.close()

            assertEquals(1, guard.inFlight, "one still in flight")
            guard.admit(UploadRoute.FILE, "alice", 1, chunked = false)
            assertFailsWith<RateLimitedException>("limit of two again") { guard.admit(UploadRoute.FILE, "alice", 1, chunked = false) }
        }

        @Test
        fun `when the instance is full then another user gets 429 too, and a place frees when an upload ends`() {
            val held = listOf("a", "b").flatMap { listOf(guard.admit(UploadRoute.FILE, it, 1, false)) }
            guard.admit(UploadRoute.FILE, "c", 1, chunked = false)

            assertFailsWith<RateLimitedException>("global limit of three") { guard.admit(UploadRoute.FILE, "d", 1, chunked = false) }
            held.first().close()
            guard.admit(UploadRoute.FILE, "d", 1, chunked = false)
        }
    }

    @Nested
    inner class StartRate {

        @Test
        fun `when a user starts more uploads than the rate in a minute then 429 before anything is held, and it recovers`() {
            repeat(3) { guard.admit(UploadRoute.FILE, "alice", 1, chunked = false).close() }

            val refused = assertFailsWith<RateLimitedException>("fourth start") {
                guard.admit(UploadRoute.FILE, "alice", 1, chunked = false)
            }
            guard.admit(UploadRoute.SNAPSHOT, "alice", 1, chunked = false).close() // another route has its own count
            clock.advanceBy(1.minutes)
            guard.admit(UploadRoute.FILE, "alice", 1, chunked = false).close()

            assertEquals(true, refused.retryAfterSeconds > 0, "Retry-After is positive")
            assertEquals(0, guard.inFlight, "all closed")
        }
    }
}
