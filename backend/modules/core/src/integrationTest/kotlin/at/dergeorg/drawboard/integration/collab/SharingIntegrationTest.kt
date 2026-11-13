package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardMove
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.BoardUpdate
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.MemberList
import at.dergeorg.drawboard.contract.model.MemberPrincipalKind
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.SharedWithMe
import at.dergeorg.drawboard.contract.model.UserSummaryList
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Folders, members, groups, inheritance, "shared with me" and the live effect of access changes on open sessions,
 * end to end on a real port with really signed tokens (the claims, not mocks, carry the groups).
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "management.otlp.metrics.export.enabled=false",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class SharingIntegrationTest(private val client: WebTestClient, @LocalServerPort private val port: Int) {

    private fun user(name: String, vararg groups: String) = SharingUser(client, port, name, groups.toList())

    /** What the user gets for GET /boards/{id}: the status and, when it is 200, the board. */
    private class Read(val status: HttpStatus, val responseBody: Board?)

    private fun SharingUser.board(id: Uuid): Read {
        val status = status("GET", "/api/boards/$id")
        val board = if (status == HttpStatus.OK) {
            http().get().uri("/api/boards/{id}", id).exchange().expectBody<Board>().returnResult().responseBody
        } else {
            null
        }
        return Read(status, board)
    }

    @Nested
    inner class DirectGrants {

        @Test
        fun `when the owner grants VIEWER then the user reads but cannot rename (403), and sees it under shared with me`() {
            val owner = user("Olga")
            val viewer = user("Vera")
            val board = owner.createBoard("Shared plan")
            assertEquals(HttpStatus.NOT_FOUND, viewer.board(board.id).status, "before the grant the board does not exist for Vera")

            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)

            val read = viewer.board(board.id)
            assertEquals(BoardRole.VIEWER, read.responseBody?.role, "role shown to the viewer")
            val rename = viewer.http().put().uri("/api/boards/{id}", board.id).bodyValue(BoardUpdate("Mine now", board.version))
                .exchange().expectBody<ErrorModel>().returnResult()
            assertEquals(HttpStatus.FORBIDDEN, rename.status, "a viewer sees the board, so 403 and not 404")
            assertEquals(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, rename.responseBody?.code, "error code")
            val shared = viewer.http().get().uri("/api/boards/shared").exchange().expectBody<SharedWithMe>().returnResult().responseBody
            assertEquals(listOf(board.id), shared?.boards?.map { it.id }, "shared with me")
        }

        @Test
        fun `when the owner removes the grant then the board is gone again for the user`() {
            val owner = user("Olga")
            val guest = user("Gus")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, guest, GrantRole.EDITOR)

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/boards/${board.id}/members/users/${guest.id}"), "remove")

            assertEquals(HttpStatus.NOT_FOUND, guest.board(board.id).status, "no role, no board")
        }

        @Test
        fun `when an editor tries to manage members then 403 and when a stranger does then 404`() {
            val owner = user("Olga")
            val editor = user("Edda")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)

            val uri = "/api/boards/${board.id}/members/users/${stranger.id}"
            assertEquals(HttpStatus.FORBIDDEN, editor.status("PUT", uri, MemberUpdate(GrantRole.VIEWER)), "editor")
            assertEquals(HttpStatus.NOT_FOUND, stranger.status("PUT", uri, MemberUpdate(GrantRole.VIEWER)), "stranger")
        }

        @Test
        fun `when granting the owner or an unknown user then 400 and 404 LIBRARY_USER_NOT_FOUND`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val self = owner.status("PUT", "/api/boards/${board.id}/members/users/${owner.id}", MemberUpdate(GrantRole.VIEWER))
            assertEquals(HttpStatus.BAD_REQUEST, self, "owner")
            val unknown = owner.http().put().uri("/api/boards/{id}/members/users/{u}", board.id, Uuid.random())
                .bodyValue(MemberUpdate(GrantRole.VIEWER))
                .exchange().expectBody<ErrorModel>().returnResult()
            assertEquals(ErrorCode.LIBRARY_USER_NOT_FOUND, unknown.responseBody?.code, "never signed in")
        }
    }

    @Nested
    inner class FoldersAndGroups {

        @Test
        fun `when a folder is shared with a group then a member of the group, by the groups claim of the token, reads boards below it`() {
            val owner = user("Olga")
            val inGroup = user("Gina", "designers")
            val outside = user("Otto")
            val folder = owner.createFolder("Design")
            val board = owner.createBoard("Logo", folder.id)

            val grant = owner.status("PUT", "/api/folders/${folder.id}/members/groups/designers", MemberUpdate(GrantRole.COMMENTER))
            assertEquals(HttpStatus.OK, grant, "grant")

            assertEquals(BoardRole.COMMENTER, inGroup.board(board.id).responseBody?.role, "inherited from the folder through the group")
            assertEquals(HttpStatus.NOT_FOUND, outside.board(board.id).status, "token without the group")
            val members = owner.http().get().uri("/api/boards/{id}/members", board.id).exchange()
                .expectBody<MemberList>().returnResult().responseBody
            assertEquals(MemberPrincipalKind.GROUP, members?.items?.single()?.principal?.kind, "group principal")
            assertEquals(folder.id, members?.items?.single()?.inheritedFrom, "shown as inherited from the folder")
        }

        @Test
        fun `when a board is moved out of a shared folder then the inherited access stops`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val folder = owner.createFolder("Open")
            val board = owner.createBoard("Inside", folder.id)
            owner.grantUser("folders", folder.id, reader, GrantRole.VIEWER)
            assertEquals(HttpStatus.OK, reader.board(board.id).status, "reader sees the board through the folder")

            val moved = owner.http().put().uri("/api/boards/{id}/folder", board.id)
                .bodyValue(BoardMove(null, board.version)).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.OK, moved.status, "move to the root")
            assertEquals(HttpStatus.NOT_FOUND, reader.board(board.id).status, "access stops with the move")
        }
    }

    /** An anonymous visitor (or a signed-in user) opening a link; every call comes from an address of its own (trusted proxy header). */
    private fun exchange(token: String, password: String? = null, user: SharingUser? = null, ip: String = randomIp()) =
        (user?.http() ?: client).post().uri("/api/shares/exchange").header("X-Forwarded-For", ip)
            .bodyValue(ShareExchange(token = token, password = password, guestName = null)).exchange()
            .expectBody<String>().returnResult()

    /** A well-formed token (43 characters of base64url) that no link has. */
    private fun unknownToken() = Uuid.random().toString().replace("-",
        "").take(32).let { java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray()) }.take(43).padEnd(43, 'x')

    private fun randomIp() = "10.${(0..255).random()}.${(0..255).random()}.${(1..254).random()}"

    private fun SharingUser.link(resource: String, id: Uuid, role: GrantRole = GrantRole.VIEWER, password: String? = null,
        audience: ShareAudience = ShareAudience.SIGNED_IN) =
        http().post().uri("/api/$resource/$id/links").bodyValue(NewShareLink(role, audience, null, password)).exchange()
            .expectBody<CreatedShareLink>().returnResult()

    @Nested
    inner class ShareLinks {

        @Test
        fun `when the owner creates a link then the URL carries the token in the fragment, the list never shows it`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val created = owner.link("boards", board.id)

            assertEquals(HttpStatus.CREATED, created.status, "created")
            val url = created.responseBody!!.url
            assertTrue(Regex("^$PUBLIC_URL/s#[A-Za-z0-9_-]{43}$").matches(url), "token in the fragment of <public url>/s, was $url")
            val list = owner.http().get().uri("/api/boards/{id}/links",
                board.id).exchange().expectBody<String>().returnResult().responseBody!!
            assertTrue(url.substringAfter('#') !in list, "the token appears only in the answer of create")
        }

        @Test
        fun `when a signed-in user opens a link then the role is remembered and revoking ends it`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val board = owner.createBoard()
            val created = owner.link("boards", board.id, GrantRole.COMMENTER).responseBody!!
            val token = created.url.substringAfter('#')

            val access = reader.http().post().uri("/api/shares/exchange").bodyValue(ShareExchange(token, null, null)).exchange()
                .expectBody<ShareAccess>().returnResult()

            assertEquals(HttpStatus.OK, access.status, "exchange")
            assertEquals(BoardRole.COMMENTER, access.responseBody?.role, "role of the link")
            assertEquals(BoardRole.COMMENTER, reader.board(board.id).responseBody?.role, "the board is readable now")
            val shared = reader.http().get().uri("/api/boards/shared").exchange().expectBody<SharedWithMe>().returnResult().responseBody
            assertEquals(listOf(board.id), shared?.boards?.map { it.id }, "in shared with me")
            val members = owner.http().get().uri("/api/boards/{id}/members",
                board.id).exchange().expectBody<MemberList>().returnResult().responseBody
            assertEquals(MemberPrincipalKind.LINK_USER, members?.items?.single()?.principal?.kind, "shown as a link member")

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/links/${created.link.id}"), "revoke")

            assertEquals(HttpStatus.NOT_FOUND, reader.board(board.id).status, "access ends with the link")
            assertEquals(HttpStatus.NOT_FOUND, exchange(token, user = reader).status, "the revoked link is dead")
        }

        @Test
        fun `when the token is unknown, revoked or expired then 404 LIBRARY_SHARE_NOT_FOUND with an identical body`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val revoked = owner.link("boards", board.id).responseBody!!
            owner.status("DELETE", "/api/links/${revoked.link.id}")
            val expiring = owner.http().post().uri("/api/boards/{id}/links", board.id)
                .bodyValue(NewShareLink(GrantRole.VIEWER, ShareAudience.SIGNED_IN,
                    // whole seconds: +1 s could already be past when a slow runner reaches the server (400)
                    java.time.Instant.now().plusSeconds(3).let { kotlin.time.Instant.fromEpochSeconds(it.epochSecond) }, null))
                .exchange().expectBody<CreatedShareLink>().returnResult().responseBody!!
            Thread.sleep(3200)

            val bodies = listOf(unknownToken(), revoked.url.substringAfter('#'), expiring.url.substringAfter('#'))
                .map { exchange(it) }
                .map { result ->
                    assertEquals(HttpStatus.NOT_FOUND, result.status, "status")
                    // requestId, traceId and timestamp differ by design; everything else must be the same
                    result.responseBody!!.replace(Regex("\"(requestId|traceId|timestamp|instance)\":\"[^\"]*\""), "")
                }

            assertEquals(1, bodies.toSet().size, "unknown, revoked and expired answer with the same body: $bodies")
            assertTrue("LIBRARY_SHARE_NOT_FOUND" in bodies.first(), "error code")
        }

        @Test
        fun `when a password protects the link then 403 required and invalid, 429 with Retry-After after five failures, never a lock`() {
            val owner = user("Olga")
            val reader = user("Rita")
            val board = owner.createBoard()
            val token = owner.link("boards", board.id, password = "right-password").responseBody!!.url.substringAfter('#')
            val ip = randomIp()

            val required = exchange(token, user = reader, ip = ip)
            val wrong = (1..5).map { exchange(token, "wrong-$it", reader, ip) }
            val blocked = exchange(token, "right-password", reader, ip)
            val elsewhere = exchange(token, "right-password", reader, randomIp())

            assertTrue("LIBRARY_SHARE_PASSWORD_REQUIRED" in required.responseBody!!, "no password: required")
            assertEquals(List(5) { HttpStatus.FORBIDDEN }, wrong.map { it.status }, "five wrong passwords")
            assertTrue(wrong.all { "LIBRARY_SHARE_PASSWORD_INVALID" in it.responseBody!! }, "error code of the wrong ones")
            assertEquals(HttpStatus.TOO_MANY_REQUESTS, blocked.status, "sixth attempt in the minute, even with the right password")
            assertTrue((blocked.responseHeaders.getFirst("Retry-After")?.toLongOrNull() ?: 0) > 0, "with a Retry-After")
            assertEquals(HttpStatus.OK, elsewhere.status,
                "another address is not blocked (per share and IP) - the share is never locked")
        }

        @Test
        fun `when ten invalid tokens come from one address in a minute then the eleventh is 429`() {
            val ip = randomIp()

            val answers = (1..11).map { exchange(unknownToken(), ip = ip).status }

            assertEquals(List(10) { HttpStatus.NOT_FOUND } + HttpStatus.TOO_MANY_REQUESTS, answers, "10 x 404, then 429")
        }

        @Test
        fun `when anonymous opens a link for signed-in users then 401 LIBRARY_SHARE_LOGIN_REQUIRED`() {
            val owner = user("Olga")
            val token = owner.link("boards", owner.createBoard().id).responseBody!!.url.substringAfter('#')

            val result = exchange(token)

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "sign in first")
            assertTrue("LIBRARY_SHARE_LOGIN_REQUIRED" in result.responseBody!!, "error code")
        }

        @Test
        fun `when guests are disabled then a GUESTS link cannot be created (403) and the exchange never gives a guest token`() {
            val owner = user("Olga")

            val board = owner.createBoard()
            val created = owner.status("POST", "/api/boards/${board.id}/links", NewShareLink(GrantRole.VIEWER, ShareAudience.GUESTS,
                null, null))

            assertEquals(HttpStatus.FORBIDDEN, created, "DRAWBOARD_GUESTS_ENABLED=false by default")
        }

        @Test
        fun `when a stranger or an editor manages links then 404 and 403`() {
            val owner = user("Olga")
            val editor = user("Edda")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)

            val request = NewShareLink(GrantRole.VIEWER, ShareAudience.SIGNED_IN, null, null)
            assertEquals(HttpStatus.FORBIDDEN, editor.status("POST", "/api/boards/${board.id}/links", request),
                "an editor sees the board: 403")
            assertEquals(HttpStatus.NOT_FOUND, stranger.status("POST", "/api/boards/${board.id}/links", request),
                "a stranger knows nothing: 404")
        }
    }

    @Nested
    inner class UserSearch {

        @Test
        fun `when searching by prefix then username and display name match, no email is returned, wildcards are literal`() {
            val finder = user("Fiona")
            val target = user("Zelda")
            target.id

            val hits = finder.http().get().uri("/api/users/search?q=zel").exchange()
                .expectBody<UserSummaryList>().returnResult().responseBody
            val wildcard = finder.http().get().uri("/api/users/search?q=%25%25").exchange()
                .expectBody<UserSummaryList>().returnResult().responseBody
            val raw = finder.http().get().uri("/api/users/search?q=zel").exchange().expectBody<String>().returnResult().responseBody

            assertTrue(hits?.items?.any { it.id == target.id } == true, "found by prefix")
            assertTrue(wildcard?.items?.isEmpty() == true, "a % is not a wildcard")
            assertTrue(raw?.contains("email") == false, "never an email")
        }

        @Test
        fun `when the term is shorter than two characters then 400`() {
            assertEquals(HttpStatus.BAD_REQUEST, user("Fiona").status("GET", "/api/users/search?q=z"), "too short")
        }
    }

    @Nested
    inner class LiveSessions {

        @Test
        fun `when the owner downgrades an editor then the open session gets a ROLE frame at once`() = runBlocking {
            val owner = user("Olga")
            val editor = user("Edda")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)
            val socket = editor.open(board)
            socket.until(ServerFrame.SYNCED)

            owner.grantUser("boards", board.id, editor, GrantRole.VIEWER)

            val role = socket.until(ServerFrame.ROLE).last().varString()
            assertTrue(role.contains("VIEWER"), "the ROLE frame names the new role, was $role")
        }

        @Test
        fun `when the owner removes a member then the open session is closed with 4403`() = runBlocking {
            val owner = user("Olga")
            val member = user("Mia")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, member, GrantRole.EDITOR)
            val socket = member.open(board)
            socket.until(ServerFrame.SYNCED)

            owner.status("DELETE", "/api/boards/${board.id}/members/users/${member.id}")

            assertEquals(4403, socket.closeStatus().code, "access lost")
        }

        @Test
        fun `when the owner moves the board to the trash then sessions of members end with 4404`() = runBlocking {
            val owner = user("Olga")
            val member = user("Mia")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, member, GrantRole.EDITOR)
            val socket = member.open(board)
            socket.until(ServerFrame.SYNCED)

            owner.status("DELETE", "/api/boards/${board.id}")

            assertEquals(4404, socket.closeStatus().code, "board in the trash")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun jwks(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
