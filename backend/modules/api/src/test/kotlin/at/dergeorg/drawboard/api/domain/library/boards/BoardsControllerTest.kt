package at.dergeorg.drawboard.api.domain.library.boards

import at.dergeorg.drawboard.api.domain.library.boards.provides.BoardsApiUseCase
import at.dergeorg.drawboard.api.domain.library.boards.provides.impl.BoardsController
import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.FieldViolation
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.PageInfo
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import com.ninjasquad.springmockk.MockkBean
import io.mockk.coEvery
import io.mockk.coVerify
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import at.dergeorg.drawboard.shared.error.ErrorCode as DomainErrorCode

/** Slice test: BoardsController + WebFlux + error rendering; the API use case is a mock. Authentication: RouteTableIntegrationTest. */
@WebFluxTest(BoardsController::class)
@Import(WebSliceTestConfiguration::class)
class BoardsControllerTest(private val client: WebTestClient) {

    @MockkBean
    private lateinit var boards: BoardsApiUseCase

    private val board = Board(
        id = BOARD,
        title = "Sprint planning",
        ownerId = OWNER,
        folderId = null,
        role = BoardRole.OWNER,
        createdAt = FIXED_NOW,
        updatedAt = FIXED_NOW,
        version = 0,
    )

    @Nested
    inner class ListBoards {

        @Test
        fun `when GET boards given no paging parameters then 200 with the first page of 20 is returned`() {
            val page = BoardPage(items = listOf(board), page = PageInfo(number = 0, size = 20, totalElements = 1, totalPages = 1))
            coEvery { boards.listBoards(null, 0, 20) } returns page

            val result = client.get().uri("/api/boards").exchange().expectBody<BoardPage>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of GET /api/boards")
            assertEquals(page, result.responseBody, "page in the body")
        }

        @Test
        fun `when GET boards given a page size of 101 then 400 VALIDATION_FAILED names the parameter`() {
            val result = client.get().uri("/api/boards?size=101").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for an invalid page size")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
            assertEquals(listOf("size"), result.responseBody?.violations?.map { it.field }, "invalid fields")
            coVerify(exactly = 0) { boards.listBoards(any(), any(), any()) }
        }

        @Test
        fun `when GET boards given an Accept header without JSON then 406 NOT_ACCEPTABLE as problem json`() {
            val result = client.get().uri("/api/boards").accept(MediaType.TEXT_PLAIN).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.NOT_ACCEPTABLE, result.status, "status for Accept: text/plain")
            assertEquals(
                MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                result.responseHeaders.getFirst(HttpHeaders.CONTENT_TYPE),
                "the error body is problem json anyway",
            )
            assertContains(result.responseBody.orEmpty(), "\"code\":\"NOT_ACCEPTABLE\"", message = "error code in the body")
        }
    }

    @Nested
    inner class GetBoard {

        @Test
        fun `when GET board given an existing id then 200 with the board`() {
            coEvery { boards.getBoard(BOARD) } returns board

            val result = client.get().uri("/api/boards/{id}", BOARD).exchange().expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of GET for an existing board")
            assertEquals(board, result.responseBody, "board in the body")
        }

        @Test
        fun `when GET board given an unknown or foreign id then 404 problem json with LIBRARY_BOARD_NOT_FOUND and the id as param`() {
            coEvery { boards.getBoard(BOARD) } throws
                DomainException(DomainErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to BOARD.toString()))

            val result = client.get().uri("/api/boards/{id}", BOARD).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status for an unknown board")
            assertEquals(MediaType.APPLICATION_PROBLEM_JSON, result.responseHeaders.contentType, "errors are RFC 9457 problem details")
            val error = assertNotNull(result.responseBody, "error body")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, error.code, "error code")
            assertEquals(mapOf("boardId" to BOARD.toString()), error.params, "params of the error")
            assertEquals("Board $BOARD not found.", error.detail, "rendered message")
            assertEquals("/api/boards/$BOARD", error.instance, "path of the request")
        }

        @Test
        fun `when GET board given an id that is no Uuid then 400 MALFORMED_REQUEST`() {
            val result = client.get().uri("/api/boards/not-a-uuid").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a malformed id")
            assertEquals(ErrorCode.MALFORMED_REQUEST, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class CreateBoard {

        @Test
        fun `when POST boards given a valid body then 201 with the board and its Location`() {
            coEvery { boards.createBoard(NewBoard("Sprint planning")) } returns board

            val result = client.post().uri("/api/boards").bodyValue(NewBoard("Sprint planning")).exchange()
                .expectBody<Board>().returnResult()

            assertEquals(HttpStatus.CREATED, result.status, "status of a successful POST")
            assertEquals("/api/boards/$BOARD", result.responseHeaders.location?.toString(), "Location of the new board")
            assertEquals(board, result.responseBody, "created board in the body")
        }

        @Test
        fun `when POST boards given an empty title then 400 VALIDATION_FAILED with a Size and a Pattern violation for title`() {
            val result = client.post().uri("/api/boards").contentType(MediaType.APPLICATION_JSON).bodyValue("""{"title":""}""")
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for an empty title")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
            assertEquals(
                setOf("title" to "Size", "title" to "Pattern"),
                result.responseBody?.violations?.map { it.field to it.code }?.toSet(),
                "violations (field, constraint): too short and no visible character",
            )
            coVerify(exactly = 0) { boards.createBoard(any()) }
        }

        @Test
        fun `when POST boards given a title of blanks only then 400 VALIDATION_FAILED with a Pattern violation for title`() {
            val result = client.post().uri("/api/boards").bodyValue(NewBoard(" \t ")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a blank title")
            assertEquals(
                listOf("title" to "Pattern"),
                result.responseBody?.violations?.map { it.field to it.code },
                "violations (field, constraint)",
            )
        }

        @Test
        fun `when POST boards given the domain rejects the title then 400 VALIDATION_FAILED with the domain's violation`() {
            coEvery { boards.createBoard(any()) } throws
                ValidationFailedException(listOf(InvalidField("title", "NotBlank", "must not be blank")))

            val result = client.post().uri("/api/boards").bodyValue(NewBoard(" x")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a domain validation failure")
            assertEquals(
                listOf(FieldViolation(field = "title", code = "NotBlank", message = "must not be blank")),
                result.responseBody?.violations,
                "violations from the domain",
            )
        }

        @Test
        fun `when POST boards given broken JSON then 400 MALFORMED_REQUEST`() {
            val result = client.post().uri("/api/boards").contentType(MediaType.APPLICATION_JSON).bodyValue("""{"title":""")
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for unreadable JSON")
            assertEquals(ErrorCode.MALFORMED_REQUEST, result.responseBody?.code, "error code")
        }

        @Test
        fun `when POST boards given plain text then 415 UNSUPPORTED_MEDIA_TYPE`() {
            val result = client.post().uri("/api/boards").contentType(MediaType.TEXT_PLAIN).bodyValue("Sprint planning")
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, result.status, "status for a text body")
            assertEquals(ErrorCode.UNSUPPORTED_MEDIA_TYPE, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class UpdateBoard {

        @Test
        fun `when PUT board given a title and the current version then 200 with the renamed board`() {
            val update = BoardUpdate(title = "Retro", version = 0)
            coEvery { boards.updateBoard(BOARD, update) } returns board.copy(title = "Retro", version = 1)

            val result = client.put().uri("/api/boards/{id}", BOARD).bodyValue(update).exchange().expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of an update")
            assertEquals("Retro" to 1L, result.responseBody?.let { it.title to it.version }, "title and version in the body")
        }

        @Test
        fun `when PUT board given a stale version then 409 CONFLICT with the current version as param`() {
            coEvery { boards.updateBoard(BOARD, any()) } throws
                DomainException(DomainErrorCode.CONFLICT, mapOf("boardId" to BOARD.toString(), "currentVersion" to "4"))

            val result = client.put().uri("/api/boards/{id}", BOARD).bodyValue(BoardUpdate(title = "x", version = 3)).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.CONFLICT, result.status, "status for a stale version")
            assertEquals(ErrorCode.CONFLICT, result.responseBody?.code, "error code")
            assertEquals("4", result.responseBody?.params?.get("currentVersion"), "current version as param")
        }

        @Test
        fun `when PUT board given a concurrent request won between read and write then 409 CONFLICT`() {
            coEvery { boards.updateBoard(BOARD, any()) } throws OptimisticLockingFailureException("version 3 is gone")

            val result = client.put().uri("/api/boards/{id}", BOARD).bodyValue(BoardUpdate(title = "x", version = 3)).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.CONFLICT, result.status, "status for a lost race")
            assertEquals(DomainErrorCode.CONFLICT.defaultMessage, result.responseBody?.detail, "own text, never the exception message")
        }

        @Test
        fun `when PUT board given a role too weak then 403 LIBRARY_BOARD_ACCESS_DENIED with the required roles`() {
            coEvery { boards.updateBoard(BOARD, any()) } throws DomainException(
                DomainErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to BOARD.toString(), "required" to "OWNER or EDITOR"),
            )

            val result = client.put().uri("/api/boards/{id}", BOARD).bodyValue(BoardUpdate(title = "x", version = 0)).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "status for a role that is too weak")
            assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, result.responseBody?.code, "error code")
            assertEquals("OWNER or EDITOR", result.responseBody?.params?.get("required"), "required roles as param")
        }

        @Test
        fun `when PUT board given no version then 400 MALFORMED_REQUEST and nothing is updated`() {
            val result = client.put().uri("/api/boards/{id}", BOARD).contentType(MediaType.APPLICATION_JSON)
                .bodyValue("""{"title":"x"}""").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status without a version")
            assertEquals(ErrorCode.MALFORMED_REQUEST, result.responseBody?.code, "a missing required property makes the body unreadable")
            coVerify(exactly = 0) { boards.updateBoard(any(), any()) }
        }
    }

    @Nested
    inner class DeleteBoard {

        @Test
        fun `when DELETE board given an existing id then 204 without body`() {
            coEvery { boards.deleteBoard(BOARD) } returns Unit

            val result = client.delete().uri("/api/boards/{id}", BOARD).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.NO_CONTENT, result.status, "status of a deletion")
            assertNull(result.responseBody, "body of a deletion")
            coVerify(exactly = 1) { boards.deleteBoard(BOARD) }
        }

        @Test
        fun `when PATCH board given the route only knows GET PUT and DELETE then 405 METHOD_NOT_ALLOWED with Allow`() {
            val result = client.method(HttpMethod.PATCH).uri("/api/boards/{id}", BOARD).bodyValue(NewBoard("x")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.METHOD_NOT_ALLOWED, result.status, "status for an unsupported method")
            assertEquals(ErrorCode.METHOD_NOT_ALLOWED, result.responseBody?.code, "error code")
            assertTrue(
                result.responseHeaders.allow.containsAll(setOf(HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE)),
                "Allow header lists the supported methods: ${result.responseHeaders.allow}",
            )
        }
    }

    @Nested
    inner class UnexpectedErrors {

        @Test
        fun `when the use case fails unexpectedly then 500 INTERNAL_ERROR without internals in the body`() {
            coEvery { boards.getBoard(BOARD) } throws IllegalStateException("connection to db-internal-7 lost")

            val result = client.get().uri("/api/boards/{id}", BOARD).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, result.status, "status of an unexpected failure")
            val body = result.responseBody.orEmpty()
            assertContains(body, "\"code\":\"INTERNAL_ERROR\"", message = "error code in the body")
            listOf("db-internal-7", "IllegalStateException", "at.dergeorg").forEach { internal ->
                assertFalse(internal in body, "neither the exception message nor a stack trace may leak: $internal")
            }
        }
    }
}
