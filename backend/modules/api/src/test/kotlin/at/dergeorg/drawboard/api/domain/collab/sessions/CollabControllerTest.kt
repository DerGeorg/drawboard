package at.dergeorg.drawboard.api.domain.collab.sessions

import at.dergeorg.drawboard.api.domain.collab.sessions.provides.CollabApiUseCase
import at.dergeorg.drawboard.api.domain.collab.sessions.provides.impl.CollabController
import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import com.ninjasquad.springmockk.MockkBean
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.slot
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.client.MultipartBodyBuilder
import org.springframework.http.codec.multipart.Part
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import org.springframework.web.reactive.function.BodyInserters
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import at.dergeorg.drawboard.shared.error.ErrorCode as DomainErrorCode

/** Slice test: CollabController + WebFlux + error rendering; the API use case is a mock. Authentication: RouteTableIntegrationTest. */
@WebFluxTest(CollabController::class)
@Import(WebSliceTestConfiguration::class)
class CollabControllerTest(private val client: WebTestClient) {

    @MockkBean
    private lateinit var collab: CollabApiUseCase

    @Nested
    inner class CreateTicket {

        @Test
        fun `when POST collab-ticket then 200 with the ticket`() {
            val ticket = CollabTicket("t".repeat(43), FIXED_NOW + 30.seconds, "/api/boards/$BOARD/collab", "drawboard.v1")
            coEvery { collab.createTicket(BOARD) } returns ticket

            val result = client.post().uri("/api/boards/$BOARD/collab-ticket").exchange().expectBody<CollabTicket>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status")
            assertEquals(ticket, result.responseBody, "body")
        }

        @Test
        fun `when the rate limit is used up then 429 TOO_MANY_REQUESTS carries Retry-After`() {
            coEvery { collab.createTicket(BOARD) } throws RateLimitedException(retryAfterSeconds = 17)

            val result = client.post().uri("/api/boards/$BOARD/collab-ticket").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, result.status, "status")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, result.responseBody?.code, "error code")
            assertEquals("17", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "seconds to wait")
        }
    }

    @Nested
    inner class UploadSnapshot {

        private fun upload(upToSeq: String = "5") = client.put().uri("/api/boards/$BOARD/snapshot?upToSeq=$upToSeq")
            .contentType(MediaType.MULTIPART_FORM_DATA)
            .body(BodyInserters.fromMultipartData(snapshotForm()))
            .exchange()

        private fun snapshotForm() = MultipartBodyBuilder().apply { part("snapshot", byteArrayOf(1, 2)).filename("s.bin") }.build()

        @Test
        fun `when PUT snapshot given a multipart part then 204 and the use case gets the seq`() {
            val seq = slot<Long>()
            coEvery { collab.uploadSnapshot(BOARD, capture(seq), any<Part>()) } returns Unit

            val result = upload().expectBody<String>().returnResult()

            assertEquals(HttpStatus.NO_CONTENT, result.status, "status")
            assertEquals(5L, seq.captured, "upToSeq from the query")
        }

        @Test
        fun `when PUT snapshot given upToSeq 0 then 400 VALIDATION_FAILED and the use case is not called`() {
            val result = upload(upToSeq = "0").expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
            coVerify(exactly = 0) { collab.uploadSnapshot(any(), any(), any()) }
        }

        @Test
        fun `when the snapshot was not requested then 409 COLLAB_SNAPSHOT_NOT_REQUESTED`() {
            coEvery { collab.uploadSnapshot(BOARD, 5, any<Part>()) } throws
                DomainException(DomainErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, mapOf("boardId" to "$BOARD", "upToSeq" to "5"))

            val result = upload().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.CONFLICT, result.status, "status")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, result.responseBody?.code, "error code")
        }
    }
}
