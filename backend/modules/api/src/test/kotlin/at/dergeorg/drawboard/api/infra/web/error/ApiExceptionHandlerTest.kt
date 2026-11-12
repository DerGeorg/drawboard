package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.files.domain.files.model.ScanUnavailableException
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger.LogLevel
import io.micrometer.tracing.Span
import io.micrometer.tracing.handler.TracingObservationHandler.TracingContext
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.http.server.reactive.observation.ServerRequestObservationContext
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.mock.http.server.reactive.MockServerHttpRequest
import org.springframework.mock.web.server.MockServerWebExchange
import at.dergeorg.drawboard.shared.error.RateLimitedException
import org.springframework.core.io.buffer.DataBufferLimitException
import org.springframework.http.HttpHeaders
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

/**
 * What the WebTestClient slice cannot see: whether a handled server error reaches the HTTP server observation (the
 * `exception` tag of http.server.requests and the error status of the HTTP span).
 */
class ApiExceptionHandlerTest {

    private val log = RecordingAppLogger()
    private val handler = ApiExceptionHandler(ProblemFactory(FixedClock(FIXED_NOW)), log, uploadLimitBytes = 50L * 1_048_576)

    private val httpSpan = mockk<Span>(relaxed = true)

    private fun observedExchange(): Pair<MockServerWebExchange, ServerRequestObservationContext> {
        val exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/api/boards"))
        val context = ServerRequestObservationContext(exchange.request, exchange.response, exchange.attributes)
        context.put(TracingContext::class.java, TracingContext().apply { span = httpSpan })
        exchange.attributes[ServerRequestObservationContext.CURRENT_OBSERVATION_CONTEXT_ATTRIBUTE] = context
        return exchange to context
    }

    @Nested
    inner class ObservationError {

        @Test
        fun `when an unexpected exception is handled then it is recorded on the HTTP observation`() {
            val (exchange, context) = observedExchange()
            val failure = IllegalStateException("connection lost")

            val response = handler.handleUnexpected(failure, exchange)

            assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.statusCode, "status of the handled failure")
            assertSame(failure, context.error, "error on the observation -> exception tag of http.server.requests")
            verify { httpSpan.error(failure) }
        }

        @Test
        fun `when an unexpected exception is handled then it is logged as error with the request as fields`() {
            val (exchange, _) = observedExchange()
            val failure = IllegalStateException("connection lost")

            handler.handleUnexpected(failure, exchange)

            val entry = log.entries.single()
            assertEquals(LogLevel.ERROR, entry.level, "level of an unexpected failure")
            assertEquals("request failed", entry.message, "constant message")
            assertSame(failure, entry.cause, "the exception goes to the log (with its stack trace)")
            assertEquals(
                mapOf(
                    "http.request.method" to "GET",
                    "url.path" to "/api/boards",
                    "http.response.status_code" to 500,
                    "error.code" to "INTERNAL_ERROR",
                ),
                entry.fields,
                "the details are fields, not part of the message",
            )
        }

        @Test
        fun `when a client error is handled then the observation stays without error`() {
            val (exchange, context) = observedExchange()

            val response = handler.handleDomain(DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to "1")), exchange)

            assertEquals(HttpStatus.NOT_FOUND, response.statusCode, "status of the handled client error")
            assertNull(context.error, "a 404 is an expected outcome, not an exception of the service")
            verify(exactly = 0) { httpSpan.error(any()) }
        }
    }

    @Nested
    inner class LogLevels {

        @Test
        fun `when a domain error of the client is handled then it is logged as info with our own message`() {
            val (exchange, _) = observedExchange()

            handler.handleDomain(DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to "1")), exchange)

            val entry = log.entries.single()
            assertEquals(LogLevel.INFO, entry.level, "level of an expected client error")
            assertEquals("request rejected", entry.message, "constant message")
            assertNull(entry.cause, "no stack trace for a client error")
            assertEquals("LIBRARY_BOARD_NOT_FOUND", entry.fields["error.code"], "error code as field")
            assertEquals(404, entry.fields["http.response.status_code"], "status as field")
        }

        @Test
        fun `when access is denied then it is logged as warn`() {
            val (exchange, _) = observedExchange()

            handler.handleAccessDenied(AccessDeniedException("denied"), exchange)

            val entry = log.entries.single()
            assertEquals(LogLevel.WARN, entry.level, "a signed-in user tried something forbidden")
            assertEquals("AccessDeniedException", entry.fields["error.type"], "exception type, not its message")
        }

        @Test
        fun `when authentication fails then it is logged as debug`() {
            val (exchange, _) = observedExchange()

            handler.handleAuthentication(BadCredentialsException("expired"), exchange)

            assertEquals(LogLevel.DEBUG, log.entries.single().level, "expired tokens are noise")
        }
    }

    @Nested
    inner class LimitsAnd429 {

        @Test
        fun `when a rate limit is hit then 429 with Retry-After and the seconds as param`() {
            val (exchange, _) = observedExchange()

            val response = handler.handleDomain(RateLimitedException(retryAfterSeconds = 42), exchange)

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, response.statusCode, "status")
            assertEquals("42", response.headers.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
            assertEquals(mapOf("retryAfterSeconds" to "42"), response.body?.params, "params")
        }

        @Test
        fun `when a codec cuts a body off at its limit then 413 PAYLOAD_TOO_LARGE with the limit`() {
            val (exchange, _) = observedExchange()

            val response = handler.handleBodyTooLarge(DataBufferLimitException("Part too big"), exchange)

            assertEquals(413, response.statusCode.value(), "status")
            assertEquals(mapOf("limit" to "52428800"), response.body?.params, "limit in bytes")
        }
    }

    @Nested
    inner class ScanUnavailable {

        @Test
        fun `when a fail-closed upload could not be scanned then 503 INTERNAL_ERROR with Retry-After and no reason in the body`() {
            val (exchange, _) = observedExchange()

            val response = handler.handleScanUnavailable(ScanUnavailableException("IO"), exchange)

            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.statusCode, "status")
            assertEquals("30", response.headers.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
            assertEquals(503, response.body?.status, "status in the body")
            assertEquals("INTERNAL_ERROR", response.body?.code?.value, "no new code, the closest existing one")
            assertEquals(false, response.body?.detail?.contains("IO"), "the reason stays out of the body")
        }

        @Test
        fun `when a fail-closed upload is refused then it is logged at WARN without a stack trace and recorded as a 5xx`() {
            val (exchange, context) = observedExchange()
            val failure = ScanUnavailableException("OPEN")

            handler.handleScanUnavailable(failure, exchange)

            val entry = log.entries.single()
            assertEquals(LogLevel.WARN, entry.level, "level")
            assertNull(entry.cause, "no stack trace")
            assertEquals("OPEN", entry.fields["files.scan.reason"], "the reason is a field")
            assertEquals(503, entry.fields["http.response.status_code"], "status field")
            assertSame(failure, context.error, "the observation sees the 5xx")
        }
    }
}
