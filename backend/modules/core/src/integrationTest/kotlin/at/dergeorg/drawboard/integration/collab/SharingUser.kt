package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.Folder
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.contract.model.NewFolder
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

/** A signed-in user of the sharing integration tests: really signed tokens (the application validates them), REST and WebSocket. */
class SharingUser(
    private val client: WebTestClient,
    private val port: Int,
    name: String,
    private val groups: List<String> = emptyList(),
) {
    val token: String = SignedTokens.token("$name-${Uuid.random()}", name, groups = groups)

    fun http(): WebTestClient = client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer $token").build()

    val id: Uuid by lazy {
        checkNotNull(http().get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody).id
    }

    fun createFolder(name: String, parentId: Uuid? = null): Folder = checkNotNull(
        http().post().uri("/api/folders").bodyValue(NewFolder(name, parentId)).exchange().expectBody<Folder>().returnResult().responseBody,
    )

    fun createBoard(title: String = "Board ${Uuid.random()}", folderId: Uuid? = null): Board = checkNotNull(
        http().post().uri("/api/boards").bodyValue(NewBoard(title, folderId)).exchange().expectBody<Board>().returnResult().responseBody,
    )

    fun status(method: String, uri: String, body: Any? = null): HttpStatus {
        val spec = http().method(org.springframework.http.HttpMethod.valueOf(method)).uri(uri)
        val result = (if (body != null) spec.bodyValue(body) else spec).exchange().expectBody<String>().returnResult()
        return HttpStatus.valueOf(result.status.value())
    }

    fun grantUser(resource: String, resourceId: Uuid, user: SharingUser, role: GrantRole) = assertEquals(
        HttpStatus.OK,
        status("PUT", "/api/$resource/$resourceId/members/users/${user.id}", MemberUpdate(role)),
        "grant $role to ${user.id}",
    )

    fun ticket(board: Board): CollabTicket = checkNotNull(
        http().post().uri("/api/boards/${board.id}/collab-ticket").exchange().expectBody<CollabTicket>().returnResult().responseBody,
    )

    fun open(board: Board): TestSocket = TestSocket.connect(port, board.id.toString(), ticket(board).ticket)
}
