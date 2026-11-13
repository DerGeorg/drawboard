package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.PageInfo
import at.dergeorg.drawboard.library.domain.boards.model.BoardCreated
import at.dergeorg.drawboard.library.domain.boards.model.BoardDeleted
import at.dergeorg.drawboard.library.domain.boards.model.BoardRenamed
import at.dergeorg.drawboard.library.domain.boards.model.BoardTemplateChanged
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.auditing.FieldChange
import at.dergeorg.drawboard.shared.context.Actor
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.shared.testing.version
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid
import at.dergeorg.drawboard.shared.context.CurrentUser as TokenUser

/**
 * Every route of /api/boards through the whole stack: security route table -> controller -> api service (looks the
 * caller up in the users module) -> library -> PostgreSQL, and the audit event that every change writes in the same
 * transaction.
 *
 * Access today: only the owner has a role. A foreign board answers 404 (never 403, its existence stays hidden), so
 * LIBRARY_BOARD_ACCESS_DENIED (403) cannot be reached through HTTP yet - the role check is covered by BoardAccessTest
 * and the controller slice; this class gets its 403 case when sharing introduces the first non-owner role.
 */
@IntegrationTest
class BoardsApiIntegrationTest(private val client: WebTestClient, private val auditLog: AuditLog) {

    /** Every test works with users of its own, so lists and counts do not depend on the other tests. */
    private val alice = TestUsers.ALICE.copy(subject = "alice-${Uuid.random()}")
    private val bob = TestUsers.BOB.copy(subject = "bob-${Uuid.random()}")

    private fun newRequestId() = "it-${Uuid.random()}"

    private fun createBoard(title: String, user: TokenUser = alice, requestId: String = newRequestId()): Board =
        checkNotNull(
            client.signedInAs(user).post().uri("/api/boards").header(RequestCorrelation.REQUEST_ID_HEADER, requestId)
                .bodyValue(NewBoard(title)).exchange().expectBody<Board>().returnResult().responseBody,
        ) { "creating '$title' failed" }

    private fun rename(board: Board, title: String, version: Long = board.version, user: TokenUser = alice) =
        client.signedInAs(user).put().uri("/api/boards/{id}", board.id).bodyValue(BoardUpdate(title = title, version = version)).exchange()

    private fun listBoards(user: TokenUser, query: String = "") =
        client.signedInAs(user).get().uri("/api/boards$query").exchange().expectBody<BoardPage>().returnResult()

    private fun meOf(user: TokenUser): CurrentUser =
        checkNotNull(client.signedInAs(user).get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody)

    @Nested
    inner class ListBoards {

        @Test
        fun `when GET boards given own boards then 200 with only the own ones, most recently changed first`() {
            val first = createBoard("List me first")
            val second = createBoard("List me second")
            createBoard("Bob's board", user = bob)
            val renamed = assertNotNull(rename(first, "List me first, changed").expectBody<Board>().returnResult().responseBody, "renamed")

            val result = listBoards(alice)

            assertEquals(HttpStatus.OK, result.status, "status of GET /api/boards")
            val page = assertNotNull(result.responseBody, "page in the body")
            assertEquals(listOf(renamed.id, second.id), page.items.map { it.id }, "own boards, the changed one first")
            assertEquals(setOf(BoardRole.OWNER), page.items.map { it.role }.toSet(), "role on own boards")
            assertEquals(2L, page.page.totalElements, "total of the own boards")
        }

        @Test
        fun `when GET boards given paging parameters then only that page is returned`() {
            repeat(3) { createBoard("Page me $it") }

            val page = assertNotNull(listBoards(alice, "?page=1&size=2").responseBody, "second page")

            assertEquals(1, page.items.size, "the last page holds the remaining board")
            assertEquals(PageInfo(number = 1, size = 2, totalElements = 3, totalPages = 2), page.page, "paging info")
        }

        @Test
        fun `when GET boards given a user without boards then 200 with an empty page`() {
            val page = assertNotNull(listBoards(bob).responseBody, "page in the body")

            assertTrue(page.items.isEmpty(), "nothing owned")
            assertEquals(0L, page.page.totalElements, "total")
        }

        @Test
        fun `when GET boards given a page size above 100 then 400 VALIDATION_FAILED`() {
            val result = client.signedInAs(alice).get().uri("/api/boards?size=101").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a too large page")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
        }

        @Test
        fun `when GET boards given no token then 401 UNAUTHORIZED`() {
            val result = client.get().uri("/api/boards").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "status without a token")
        }
    }

    @Nested
    inner class GetBoard {

        @Test
        fun `when GET board given the owner then 200 with the stored board`() {
            val created = createBoard("Read me back")

            val result = client.signedInAs(alice).get().uri("/api/boards/{id}", created.id).exchange().expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of GET for an own board")
            assertEquals(created, result.responseBody, "board read back from PostgreSQL")
        }

        @Test
        fun `when GET board given another user's board then 404 LIBRARY_BOARD_NOT_FOUND, exactly like an unknown id`() {
            val foreign = createBoard("Alice's secret")

            val foreignResult = client.signedInAs(bob).get().uri("/api/boards/{id}", foreign.id)
                .exchange().expectBody<ErrorModel>().returnResult()
            val unknownResult = client.signedInAs(bob).get().uri("/api/boards/{id}", Uuid.random())
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, foreignResult.status, "status for a foreign board")
            val error = assertNotNull(foreignResult.responseBody, "error body")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, error.code, "error code")
            assertEquals(mapOf("boardId" to foreign.id.toString()), error.params, "params")
            assertEquals(
                HttpStatus.NOT_FOUND to ErrorCode.LIBRARY_BOARD_NOT_FOUND,
                unknownResult.status to unknownResult.responseBody?.code,
                "unknown id answers the same",
            )
            assertTrue(!error.requestId.isNullOrBlank(), "the body carries a request id")
            assertEquals(
                foreignResult.responseHeaders.getFirst(RequestCorrelation.REQUEST_ID_HEADER),
                error.requestId,
                "the body quotes the request id of the response header",
            )
        }

        @Test
        fun `when GET board given an id that is no Uuid then 400 MALFORMED_REQUEST`() {
            val result = client.signedInAs(alice).get().uri("/api/boards/not-a-uuid").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a malformed id")
            assertEquals(ErrorCode.MALFORMED_REQUEST, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class CreateBoard {

        @Test
        fun `when POST boards given a title then 201 owned by the caller and the board and its audit event are stored`() = runTest {
            val requestId = newRequestId()

            val result = client.signedInAs(alice).post().uri("/api/boards").header(RequestCorrelation.REQUEST_ID_HEADER, requestId)
                .bodyValue(NewBoard("  Ship the template  ")).exchange().expectBody<Board>().returnResult()

            assertEquals(HttpStatus.CREATED, result.status, "status of POST /api/boards")
            val board = assertNotNull(result.responseBody, "created board in the body")
            assertEquals("Ship the template", board.title, "stored title is trimmed")
            assertEquals(7, board.id.version(), "server-assigned UUIDv7")
            assertEquals(meOf(alice).id, board.ownerId, "owner = our own user id of the caller, not the token subject")
            assertEquals(BoardRole.OWNER, board.role, "the creator is the owner")
            assertEquals(0L, board.version, "first version")
            assertEquals("/api/boards/${board.id}", result.responseHeaders.location?.path, "Location")

            val event = auditLog.history("board", board.id.toString()).single()
            assertEquals("library.board.created", event.eventType, "event type")
            assertEquals(AuditAction.CREATED, event.action, "action")
            assertEquals(Actor.user(alice.subject), event.actor, "actor = token subject")
            assertEquals(requestId, event.requestId, "request id of the HTTP request")
            assertTrue(TRACE_ID.matches(event.traceId.orEmpty()), "trace id (32 hex characters): ${event.traceId}")
            assertContains(event.changes, FieldChange("title", null, "Ship the template"), "changes of a created board")
            assertEquals(BoardCreated(submittedTitle = "  Ship the template  "), event.detailsAs<BoardCreated>(), "typed details")
        }

        @Test
        fun `when POST boards given a first call before users me then the profile is created on the fly`() {
            val fresh = TestUsers.ALICE.copy(subject = "fresh-${Uuid.random()}")

            val board = createBoard("First thing I do", user = fresh)

            assertEquals(meOf(fresh).id, board.ownerId, "the profile created by the board call is the one /users/me returns")
        }

        @Test
        fun `when POST boards given a title of blanks then 400 VALIDATION_FAILED and nothing is stored or audited`() = runTest {
            val requestId = newRequestId()

            val result = client.signedInAs(alice).post().uri("/api/boards").header(RequestCorrelation.REQUEST_ID_HEADER, requestId)
                .bodyValue(NewBoard("   ")).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a blank title")
            assertEquals(MediaType.APPLICATION_PROBLEM_JSON, result.responseHeaders.contentType, "content type")
            assertEquals(
                listOf("title" to "Pattern"),
                result.responseBody?.violations?.map { it.field to it.code },
                "violations: the contract's pattern rejects a title of blanks",
            )
            val message = result.responseBody?.violations?.single()?.message.orEmpty()
            assertTrue(message.startsWith("must match"), "violation messages are English, whatever the locale of the machine: $message")
            assertTrue(
                auditLog.find(AuditFilter(requestId = requestId), PageQuery(0, 10)).items.isEmpty(),
                "the rejected request may not be audited",
            )
        }

        @Test
        fun `when POST boards given no token then 401 UNAUTHORIZED with a Bearer challenge`() {
            val result = client.post().uri("/api/boards").bodyValue(NewBoard("Anonymous"))
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "status without a token")
            assertEquals(ErrorCode.UNAUTHORIZED, result.responseBody?.code, "error code")
            assertEquals("Bearer", result.responseHeaders.getFirst(HttpHeaders.WWW_AUTHENTICATE), "challenge")
        }
    }

    @Nested
    inner class UpdateBoard {

        @Test
        fun `when PUT board given the current version then 200 with the next version and the rename is audited`() = runTest {
            val board = createBoard("Rename me")

            val result = rename(board, " Renamed ").expectBody<Board>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of the update")
            val updated = assertNotNull(result.responseBody, "updated board in the body")
            assertEquals("Renamed", updated.title, "trimmed new title")
            assertEquals(board.version + 1, updated.version, "version after one change")
            assertTrue(
                updated.updatedAt >= board.updatedAt && updated.createdAt == board.createdAt,
                "update time moves, creation time stays",
            )
            val event = auditLog.history("board", board.id.toString()).last()
            assertEquals("library.board.updated", event.eventType, "last event")
            assertContains(event.changes, FieldChange("title", "Rename me", "Renamed"), "changes of the update")
            assertEquals(
                BoardRenamed(submittedTitle = " Renamed ", basedOnVersion = board.version),
                event.detailsAs<BoardRenamed>(),
                "typed details",
            )
        }

        @Test
        fun `when PUT board given a version that is no longer current then 409 CONFLICT and the title is kept`() {
            val board = createBoard("Change me once")
            assertEquals(
                HttpStatus.OK,
                rename(board, "First change").expectBody<Board>().returnResult().status,
                "status of the first update",
            )

            val result = rename(board, "Second change").expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.CONFLICT, result.status, "status for a stale version")
            assertEquals(MediaType.APPLICATION_PROBLEM_JSON, result.responseHeaders.contentType, "content type")
            assertEquals(ErrorCode.CONFLICT, result.responseBody?.code, "error code")
            assertEquals(
                mapOf("boardId" to board.id.toString(), "currentVersion" to (board.version + 1).toString()),
                result.responseBody?.params,
                "params of the conflict",
            )
            val stored = client.signedInAs(alice).get().uri("/api/boards/{id}", board.id).exchange().expectBody<Board>().returnResult()
            assertEquals("First change", stored.responseBody?.title, "the first change wins")
        }

        @Test
        fun `when PUT board given another user's board then 404 LIBRARY_BOARD_NOT_FOUND and the title is kept`() {
            val board = createBoard("Not yours")

            val result = rename(board, "Mine now", user = bob).expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status for a foreign board")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "error code")
            val stored = client.signedInAs(alice).get().uri("/api/boards/{id}", board.id).exchange().expectBody<Board>().returnResult()
            assertEquals(board, stored.responseBody, "board untouched")
        }

        @Test
        fun `when PUT board given a title of blanks then 400 VALIDATION_FAILED`() {
            val board = createBoard("Keep my title")

            val result = rename(board, "  ").expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a blank title")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class Templates {

        private fun createTemplate(title: String): Board = checkNotNull(
            client.signedInAs(alice).post().uri("/api/boards").bodyValue(NewBoard(title, template = true)).exchange()
                .expectBody<Board>().returnResult().responseBody,
        ) { "creating template '$title' failed" }

        private fun setTemplate(board: Board, template: Boolean?, user: TokenUser = alice) =
            client.signedInAs(user).put().uri("/api/boards/{id}", board.id)
                .bodyValue(BoardUpdate(title = board.title, version = board.version, template = template)).exchange()

        @Test
        fun `when POST boards given template true then the board is stored as a template, and by default it is not`() {
            val template = createTemplate("A template")
            val plain = createBoard("Not a template")

            assertEquals(true, template.template, "created as a template")
            assertEquals(false, plain.template, "default")
            val read = client.signedInAs(alice).get().uri("/api/boards/{id}", template.id).exchange().expectBody<Board>().returnResult()
            assertEquals(true, read.responseBody?.template, "read back from PostgreSQL")
        }

        @Test
        fun `when the owner toggles the template flag then the version rises and each change is audited`() = runTest {
            val board = createBoard("Toggle me")

            val marked = assertNotNull(setTemplate(board, true).expectBody<Board>().returnResult().responseBody, "marked")
            val unmarked = assertNotNull(setTemplate(marked, false).expectBody<Board>().returnResult().responseBody, "unmarked")

            assertEquals(listOf(true, false), listOf(marked.template, unmarked.template), "flag after each call")
            assertEquals(board.version + 2, unmarked.version, "version raised by every change")
            val changes = auditLog.history("board", board.id.toString()).filter { it.eventType == "library.board.updated" }
            assertEquals(
                listOf(BoardTemplateChanged(true, board.version), BoardTemplateChanged(false, marked.version)),
                changes.map { it.detailsAs<BoardTemplateChanged>() },
                "typed details of both changes",
            )
            assertContains(changes.first().changes, FieldChange("template", false, true), "field change")
        }

        @Test
        fun `when PUT board given no template field then the flag stays`() {
            val template = createTemplate("Keep me")

            val renamed = assertNotNull(rename(template, "Kept").expectBody<Board>().returnResult().responseBody, "renamed")

            assertEquals(true, renamed.template, "absent = unchanged")
            assertEquals("Kept", renamed.title, "title changed")
        }
    }

    @Nested
    inner class DeleteBoard {

        @Test
        fun `when DELETE board given the owner then 204 the board is gone and the deletion is audited with the snapshot`() = runTest {
            val board = createBoard("Delete me")

            val result = client.signedInAs(alice).delete().uri("/api/boards/{id}", board.id).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.NO_CONTENT, result.status, "status of the deletion")
            val afterwards = client.signedInAs(alice).get().uri("/api/boards/{id}", board.id)
                .exchange().expectBody<ErrorModel>().returnResult()
            assertEquals(HttpStatus.NOT_FOUND, afterwards.status, "status of GET after the deletion")
            val deleted = auditLog.history("board", board.id.toString()).last()
            assertEquals("library.board.deleted", deleted.eventType, "last event")
            assertContains(deleted.changes, FieldChange("title", "Delete me", null), "the snapshot before the deletion")
            assertTrue(deleted.details is BoardDeleted, "typed details: ${deleted.details}")
        }

        @Test
        fun `when DELETE board given another user's board then 404 LIBRARY_BOARD_NOT_FOUND and the board still exists`() = runTest {
            val board = createBoard("Keep me")

            val result = client.signedInAs(bob).delete().uri("/api/boards/{id}", board.id)
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status for a foreign board")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "error code")
            assertEquals(
                listOf("library.board.created"),
                auditLog.history("board", board.id.toString()).map { it.eventType },
                "nothing but the creation happened",
            )
            val stored = client.signedInAs(alice).get().uri("/api/boards/{id}", board.id).exchange().expectBody<Board>().returnResult()
            assertEquals(HttpStatus.OK, stored.status, "the owner still sees the board")
        }

        @Test
        fun `when DELETE board given an unknown id then 404 LIBRARY_BOARD_NOT_FOUND`() {
            val result = client.signedInAs(alice).delete().uri("/api/boards/{id}", Uuid.random())
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status for an unknown board")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "error code")
        }
    }

    private companion object {
        val TRACE_ID = Regex("[0-9a-f]{32}")
    }
}
