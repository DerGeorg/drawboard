package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.sdk.trace.data.SpanData
import kotlinx.coroutines.test.runTest
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.time.Duration.Companion.seconds
import kotlin.time.toJavaDuration
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Traces and request ids of a real use case: one trace per request, nested spans, the request id everywhere. */
@IntegrationTest
class ObservabilityIntegrationTest(
    private val client: WebTestClient,
    private val spans: CapturedSpans,
    private val auditLog: AuditLog,
) {

    @BeforeEach
    fun forgetEarlierSpans() {
        // Alice's profile exists after this call, so the request under test creates no second one (and no second audit span).
        client.signedInAs(ALICE).get().uri("/api/users/me").exchange().expectBody<String>().returnResult()
        spans.clear()
    }

    private fun span(name: String): SpanData {
        await().atMost(5.seconds.toJavaDuration()).until { spans.finished.any { it.name == name } }
        return spans.finished.first { it.name == name }
    }

    private fun createBoard(requestId: String? = null): Pair<Board, String?> {
        val request = client.signedInAs(ALICE).post().uri("/api/boards")
        requestId?.let { request.header(RequestCorrelation.REQUEST_ID_HEADER, it) }
        val result = request.bodyValue(NewBoard("Trace me")).exchange().expectBody<Board>().returnResult()
        return checkNotNull(result.responseBody) to result.responseHeaders.getFirst(RequestCorrelation.REQUEST_ID_HEADER)
    }

    @Nested
    inner class Spans {

        @Test
        fun `when creating a board then controller api service use case and audit spans nest in one trace`() {
            createBoard()

            val controller = span("BoardsController.createBoard")
            val apiService = span("LibraryApiService.createBoard")
            val useCase = span("LibraryService.createBoard")
            val audit = span("AuditingService.record")

            assertEquals(controller.spanId, apiService.parentSpanId, "api service span is a child of the controller span")
            assertEquals(apiService.spanId, useCase.parentSpanId, "use case span is a child of the api service span")
            assertEquals(useCase.spanId, audit.parentSpanId, "audit span is a child of the use case span")
            assertEquals(
                1,
                setOf(controller.traceId, apiService.traceId, useCase.traceId, audit.traceId).size,
                "one request = one trace",
            )
        }

        @Test
        fun `when creating a board then the repository span sits under the use case and the R2DBC query under the repository`() {
            createBoard()

            val useCase = span("LibraryService.createBoard")
            val repository = span("BoardRepositoryAdapter.insert")
            val query = spans.finished.filter { it.name == "query" }.firstOrNull { it.parentSpanId == repository.spanId }

            assertEquals(useCase.spanId, repository.parentSpanId, "repository span is a child of the use case span")
            assertNotNull(query, "the INSERT is an R2DBC query span below the repository span")
        }

        @Test
        fun `when creating a board then every method span starts and ends within its parent span`() {
            createBoard()

            // Phase 1 trace: LibraryService.createBoard (@Transactional, ends after the commit) outlasted its parent.
            SPANS_OF_CREATE_BOARD.map(::span).zipWithNext().forEach { (parent, child) ->
                assertTrue(child.startEpochNanos >= parent.startEpochNanos, "${child.name} must start after its parent ${parent.name}")
                assertTrue(child.endEpochNanos <= parent.endEpochNanos, "${child.name} must end before its parent ${parent.name}")
            }
        }

        @Test
        fun `when a request id is sent then every span of the request carries it`() {
            createBoard(requestId = "observability-it-0001")

            SPANS_OF_CREATE_BOARD.map(::span).forEach { span ->
                assertEquals(
                    "observability-it-0001",
                    span.attributes.get(AttributeKey.stringKey(RequestCorrelation.REQUEST_ID_SPAN_ATTRIBUTE)),
                    "request.id on span ${span.name}",
                )
            }
        }
    }

    @Nested
    inner class RequestIds {

        @Test
        fun `when a request id is sent then it is echoed and stored in the audit event`() = runTest {
            val (board, echoed) = createBoard(requestId = "observability-it-0002")

            assertEquals("observability-it-0002", echoed, "X-Request-Id of the response")
            assertEquals(
                "observability-it-0002",
                auditLog.history("board", board.id.toString()).single().requestId,
                "request id of the audit event",
            )
        }

        @Test
        fun `when no request id is sent then the trace id becomes the request id`() = runTest {
            val (board, echoed) = createBoard()

            val event = auditLog.history("board", board.id.toString()).single()
            assertTrue(TRACE_ID.matches(echoed.orEmpty()), "generated request id is a trace id: $echoed")
            assertEquals(echoed, event.traceId, "trace id of the audit event = request id")
            assertEquals(echoed, event.requestId, "request id of the audit event")
        }
    }

    private companion object {
        val TRACE_ID = Regex("[0-9a-f]{32}")

        /** From the outside in: controller -> api service -> use case -> audit. */
        val SPANS_OF_CREATE_BOARD = listOf(
            "BoardsController.createBoard",
            "LibraryApiService.createBoard",
            "LibraryService.createBoard",
            "AuditingService.record",
        )
    }
}
