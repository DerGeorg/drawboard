package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardMove
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.NewFolder
import at.dergeorg.drawboard.shared.testing.TestUsers
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.EntityExchangeResult
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.uuid.Uuid
import at.dergeorg.drawboard.shared.context.CurrentUser as TokenUser

/** A user of its own per test class, so lists and counts do not depend on the other tests. */
fun uniqueUser(base: TokenUser, groups: Set<String> = base.groups): TokenUser =
    base.copy(subject = "${base.username}-${Uuid.random()}", groups = groups, admin = false)

/** Calls the API as one user; every helper checks the status it expects, so a test reads as the story of the flow. */
class ApiAs(private val client: WebTestClient, val user: TokenUser) {

    private val http get() = client.signedInAs(user)

    /** Signs the user up (the profile is created by the first request). Returns the application's own user id. */
    fun id(): Uuid = checkNotNull(http.get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody).id

    fun createBoard(title: String, folderId: Uuid? = null): Board = created(HttpStatus.CREATED) {
        http.post().uri("/api/boards").bodyValue(NewBoard(title = title, folderId = folderId)).exchange().expectBody<Board>().returnResult()
    }

    fun createFolder(name: String, parentId: Uuid? = null): Folder = created(HttpStatus.CREATED) {
        http.post().uri("/api/folders").bodyValue(NewFolder(name = name, parentId = parentId)).exchange()
            .expectBody<Folder>().returnResult()
    }

    fun move(board: Board, folderId: Uuid?) =
        http.put().uri("/api/boards/{id}/folder", board.id).bodyValue(BoardMove(folderId = folderId, version = board.version)).exchange()
            .expectBody<String>().returnResult()

    fun get(uri: String, vararg vars: Any) = http.get().uri(uri, *vars).exchange().expectBody<String>().returnResult()

    fun status(method: String, uri: String, vararg vars: Any, body: Any? = null): HttpStatus {
        val spec = http.method(org.springframework.http.HttpMethod.valueOf(method)).uri(uri, *vars)
        val exchange = (if (body != null) spec.bodyValue(body) else spec).exchange()
        return HttpStatus.valueOf(exchange.expectBody<String>().returnResult().status.value())
    }

    private fun <T : Any> created(status: HttpStatus, call: () -> EntityExchangeResult<T>): T {
        val result = call()
        assertEquals(status, result.status, "expected $status, body ${result.responseBody}")
        return checkNotNull(result.responseBody) { "empty body" }
    }

    companion object {
        val ALICE = uniqueUser(TestUsers.ALICE)
    }
}
