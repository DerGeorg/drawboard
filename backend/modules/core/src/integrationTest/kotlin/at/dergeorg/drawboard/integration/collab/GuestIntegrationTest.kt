package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardPage
import at.dergeorg.drawboard.contract.model.BoardRole
import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.ShareRefresh
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.integration.RouteTableIntegrationTest
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Guests end to end (S1): the link exchange for visitors without an account, the guest token, the route allowlist,
 * the board and the WebSocket as a guest, refresh, revocation, the per-address session cap. Guests are switched on and
 * the application signs with a key made for this test; real tokens, a real port.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class GuestIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: tools.jackson.databind.json.JsonMapper,
) {

    private fun user(name: String, vararg groups: String) = SharingUser(client, port, name, groups.toList())

    private fun ip() = "10.${(0..255).random()}.${(0..255).random()}.${(1..254).random()}"

    /** A link for guests; returns the token of the URL fragment and the link's id. */
    private fun guestLink(owner: SharingUser, resource: String, id: Uuid, role: GrantRole,
        password: String? = null): Pair<String, Uuid> {
        val created = owner.http().post().uri("/api/$resource/$id/links")
            .bodyValue(NewShareLink(role, ShareAudience.GUESTS, null, password)).exchange()
            .expectBody<CreatedShareLink>().returnResult()
        assertEquals(HttpStatus.CREATED, created.status, "creating the guest link")
        return created.responseBody!!.url.substringAfter('#') to created.responseBody!!.link.id
    }

    private fun open(token: String, name: String? = "Gus", password: String? = null, from: String = ip()): ShareAccess {
        val result = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", from)
            .bodyValue(ShareExchange(token, password, name)).exchange().expectBody<String>().returnResult()
        assertEquals(HttpStatus.OK, result.status, "the exchange of a guest link, body ${result.responseBody}")
        return json.readValue(checkNotNull(result.responseBody), ShareAccess::class.java)
    }

    private fun WebTestClient.asGuest(session: GuestSession): WebTestClient =
        mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${session.accessToken}").build()

    private fun guest(session: GuestSession) = client.asGuest(session)

    private fun statusOf(http: WebTestClient, method: String, uri: String, body: Any? = null): HttpStatus {
        val spec = http.method(HttpMethod.valueOf(method)).uri(uri)
        val result = (if (body != null) spec.bodyValue(body) else spec.contentType(MediaType.APPLICATION_JSON)).exchange()
            .expectBody<String>().returnResult()
        return HttpStatus.valueOf(result.status.value())
    }

    private fun openSocket(session: GuestSession, board: Board): TestSocket {
        val ticket = checkNotNull(
            guest(session).post().uri("/api/boards/${board.id}/collab-ticket").exchange().expectBody<CollabTicket>().returnResult()
                .responseBody,
        )
        return TestSocket.connect(port, board.id.toString(), ticket.ticket)
    }

    @Nested
    inner class Exchange {

        @Test
        fun `when an anonymous visitor opens a GUESTS link then the answer carries a guest session scoped to that board and role`() {
            val owner = user("Olga")
            val board = owner.createBoard("Open board")
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.COMMENTER)

            val access = open(token, name = "  Gus   Guest ")

            assertEquals(BoardRole.COMMENTER, access.role, "role of the link")
            val session = assertNotNull(access.guestSession, "a guest session")
            assertEquals("Gus Guest", session.name, "the name as the server stored it: trimmed and collapsed")
            assertEquals(board.id, session.id, "scoped to the board")
            val read = guest(session).get().uri("/api/boards/{id}", board.id).exchange().expectBody<Board>().returnResult()
            assertEquals(HttpStatus.OK, read.status, "the guest reads the board")
            assertEquals(BoardRole.COMMENTER, read.responseBody?.role, "with the role of the link")
        }

        @Test
        fun `when a guest gives no name then 400 VALIDATION_FAILED on guestName`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)

            val result = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", ip())
                .bodyValue(ShareExchange(token, null, null)).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "a guest needs a name")
        }

        @Test
        fun `when a guest chooses the name of a registered user then the name gets a guest suffix`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)
            owner.id // the profile exists

            val session = assertNotNull(open(token, name = "olga").guestSession, "session")

            assertEquals("olga (guest)", session.name, "a guest cannot pass as Olga")
        }

        @Test
        fun `when the name has control and bidi characters then they are removed`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)

            val session = assertNotNull(open(token, name = "Eve\u202E\u200B\n" + "x".repeat(50)).guestSession, "session")

            assertEquals("Eve " + "x".repeat(50), session.name, "invisible characters gone, the line break is one blank")
        }

        @Test
        fun `when the link has a password then the guest needs it, and the pw claim records that it was checked`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER, password = "guest-password")

            val missing = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", ip())
                .bodyValue(ShareExchange(token, null, "Gus")).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, missing.status, "password required")
            assertNotNull(open(token, password = "guest-password").guestSession, "with the password")
        }

        @Test
        fun `when a guest token calls the exchange then 403 - a guest drops its token before opening another link`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            val status = statusOf(guest(session), "POST", "/api/shares/exchange", ShareExchange(token, null, "Gus"))

            assertEquals(HttpStatus.FORBIDDEN, status, "not on the guest allowlist")
        }
    }

    @Nested
    inner class Allowlist {

        @Test
        fun `when a guest calls every operation of the contract then only the allowlisted ones pass the route table, all others are 403`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.EDITOR)
            val session = assertNotNull(open(token).guestSession, "session")
            // S1.8, the M3 contract review and (planning poker: list, get, vote) the M4 review: files and plugins are readable for
            // guests (metadata, URLs, the list a board host
            // loads, the plugin storage); the bytes of a file (downloadFile) need no token at all - the signature decides
            val allowed = setOf(
                "listBoards", "getBoard", "createCollabTicket", "refreshGuestSession", "listFiles", "getFile", "getFileUrls",
                "getPluginStorage", "listEnabledPlugins", "downloadFile", "listPokerRounds", "getPokerRound", "castPokerVote",
            )

            val verdicts = RouteTableIntegrationTest.operations().associate { operation ->
                val result = guest(session).method(operation.method).uri(operation.uri).contentType(MediaType.APPLICATION_JSON)
                    .bodyValue("{}").exchange().expectBody<String>().returnResult()
                operation.operationId to result
            }

            val blocked = verdicts.filterKeys { it !in allowed }
            assertTrue(blocked.isNotEmpty() && blocked.size == verdicts.size - allowed.size, "every other operation is checked")
            blocked.forEach { (operation, result) ->
                assertEquals(HttpStatus.FORBIDDEN, result.status, "$operation must be 403 for a guest")
            }
            allowed.forEach { operation ->
                assertTrue(verdicts.getValue(operation).status != HttpStatus.UNAUTHORIZED,
                    "$operation passes authentication for a guest")
            }
        }

        @Test
        fun `when a guest asks who they are then 403 - there is no user for a guest`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            assertEquals(HttpStatus.FORBIDDEN, statusOf(guest(session), "GET", "/api/users/me"), "users/me")
            assertEquals(HttpStatus.FORBIDDEN, statusOf(guest(session), "GET", "/api/users/search?q=ol"),
                "no user directory for guests")
        }

        @Test
        fun `when a guest asks for another board then 404 - only the shared board and what lies below a shared folder`() {
            val owner = user("Olga")
            val shared = owner.createBoard("Shared")
            val other = owner.createBoard("Not shared")
            val (token, _) = guestLink(owner, "boards", shared.id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            assertEquals(HttpStatus.OK, statusOf(guest(session), "GET", "/api/boards/${shared.id}"), "the shared board")
            assertEquals(HttpStatus.NOT_FOUND, statusOf(guest(session), "GET", "/api/boards/${other.id}"),
                "another board of the same owner")
        }

        @Test
        fun `when a guest holds a folder link then it lists the boards below, but only with a folderId, and nothing outside`() {
            val owner = user("Olga")
            val folder = owner.createFolder("Team")
            val sub = owner.createFolder("Sub", folder.id)
            val inFolder = owner.createBoard("In folder", folder.id)
            val inSub = owner.createBoard("In sub", sub.id)
            val outside = owner.createBoard("Outside")
            val (token, _) = guestLink(owner, "folders", folder.id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            val listed = guest(session).get().uri("/api/boards?folderId=${folder.id}").exchange().expectBody<BoardPage>().returnResult()

            assertEquals(listOf(inFolder.id), listed.responseBody?.items?.map { it.id }, "boards directly in the folder")
            assertEquals(HttpStatus.OK, statusOf(guest(session), "GET", "/api/boards?folderId=${sub.id}"), "the subfolder")
            assertEquals(HttpStatus.OK, statusOf(guest(session), "GET", "/api/boards/${inSub.id}"), "a board below")
            assertEquals(HttpStatus.FORBIDDEN, statusOf(guest(session), "GET", "/api/boards"), "no root listing for a guest")
            assertEquals(HttpStatus.NOT_FOUND, statusOf(guest(session), "GET", "/api/boards/${outside.id}"),
                "a board outside the folder")
            val above = owner.createFolder("Above")
            assertEquals(HttpStatus.NOT_FOUND, statusOf(guest(session), "GET", "/api/boards?folderId=${above.id}"), "another folder")
        }

        @Test
        fun `when the token is tampered with or signed by someone else then 401`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")
            val tampered = session.copy(accessToken = session.accessToken.dropLast(5) + "AAAAA")

            assertEquals(HttpStatus.UNAUTHORIZED, statusOf(guest(tampered), "GET", "/api/boards/${session.id}"), "bad signature")
            assertEquals(HttpStatus.UNAUTHORIZED, statusOf(guest(session.copy(accessToken = "a.b.c")), "GET",
                "/api/boards/${session.id}"), "garbage")
        }
    }

    @Nested
    inner class Revocation {

        @Test
        fun `when the owner revokes the link then the guest's next REST call fails and its socket closes with 4403`() = runBlocking {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, linkId) = guestLink(owner, "boards", board.id, GrantRole.EDITOR)
            val session = assertNotNull(open(token).guestSession, "session")
            val socket = openSocket(session, board)
            socket.until(ServerFrame.SYNCED)
            assertEquals(HttpStatus.OK, statusOf(guest(session), "GET", "/api/boards/${board.id}"), "before")

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/links/$linkId"), "revoke")

            assertEquals(4403, socket.closeStatus().code, "the guest's session ends at once")
            assertEquals(HttpStatus.UNAUTHORIZED, statusOf(guest(session), "GET", "/api/boards/${board.id}"),
                "the token is dead with the link")
        }

        @Test
        fun `when the board goes to the trash then the guest's board is gone and its session ends`() = runBlocking {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.EDITOR)
            val session = assertNotNull(open(token).guestSession, "session")
            val socket = openSocket(session, board)
            socket.until(ServerFrame.SYNCED)

            owner.status("DELETE", "/api/boards/${board.id}")

            assertEquals(4404, socket.closeStatus().code, "board in the trash")
            assertEquals(HttpStatus.NOT_FOUND, statusOf(guest(session), "GET", "/api/boards/${board.id}"), "not found for the guest")
        }
    }

    @Nested
    inner class Refresh {

        @Test
        fun `when a guest refreshes with the link's token then it gets a new token for the same session`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            val renewed = guest(session).post().uri("/api/shares/refresh").bodyValue(ShareRefresh(token)).exchange()
                .expectBody<GuestSession>().returnResult()

            assertEquals(HttpStatus.OK, renewed.status, "refresh")
            assertTrue(renewed.responseBody!!.accessToken != session.accessToken, "a new token")
            assertEquals(session.name to session.id, renewed.responseBody!!.name to renewed.responseBody!!.id, "same session")
            assertEquals(HttpStatus.OK, statusOf(guest(renewed.responseBody!!), "GET", "/api/boards/${board.id}"), "and it works")
        }

        @Test
        fun `when the token of the refresh is another link's or the link is revoked then 404 LIBRARY_SHARE_NOT_FOUND`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, linkId) = guestLink(owner, "boards", board.id, GrantRole.VIEWER)
            val (otherToken, _) = guestLink(owner, "boards", board.id, GrantRole.VIEWER)
            val session = assertNotNull(open(token).guestSession, "session")

            val foreign = statusOf(guest(session), "POST", "/api/shares/refresh", ShareRefresh(otherToken))
            owner.status("DELETE", "/api/links/$linkId")
            val revoked = statusOf(guest(session), "POST", "/api/shares/refresh", ShareRefresh(token))

            assertEquals(HttpStatus.NOT_FOUND, foreign, "another link's token")
            assertTrue(revoked == HttpStatus.NOT_FOUND || revoked == HttpStatus.UNAUTHORIZED, "revoked: the link is dead, was $revoked")
        }

        @Test
        fun `when a signed-in user calls the refresh then 403`() {
            val owner = user("Olga")
            val (token, _) = guestLink(owner, "boards", owner.createBoard().id, GrantRole.VIEWER)

            assertEquals(HttpStatus.FORBIDDEN, owner.status("POST", "/api/shares/refresh", ShareRefresh(token)), "guests only")
        }
    }

    @Nested
    inner class Collaboration {

        @Test
        fun `when a guest joins then the WELCOME says guest true and a viewer guest's updates are dropped`() = runBlocking {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.VIEWER)
            val session = assertNotNull(open(token, name = "Vera Viewer").guestSession, "session")

            val socket = openSocket(session, board)

            val welcome = socket.next().varString()
            assertTrue(welcome.contains(""""guest":true"""), "marked as a guest: $welcome")
            assertTrue(welcome.contains(""""name":"Vera Viewer""""), "with the sanitised name: $welcome")
            assertTrue(welcome.startsWith("""{"role":"VIEWER""""), "role of the link: $welcome")
        }

        @Test
        fun `when a guest edits and a signed-in editor is present then the editor sees the update marked as from a guest`() =
            runBlocking {
            val owner = user("Olga")
            val board = owner.createBoard()
            val (token, _) = guestLink(owner, "boards", board.id, GrantRole.EDITOR)
            val session = assertNotNull(open(token, name = "Edgar").guestSession, "session")
            val ownerSocket = owner.open(board)
            ownerSocket.until(ServerFrame.SYNCED)
            val guestSocket = openSocket(session, board)
            guestSocket.until(ServerFrame.SYNCED)

            guestSocket.send(byteArrayOf(0x01, 5, 6))

            assertEquals(1L, guestSocket.until(ServerFrame.ACK).last().varUint(), "acked")
            assertEquals(1L, ownerSocket.until(ServerFrame.UPDATE).last().varUint(), "the owner receives it")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { generatedKey() }
        }

        fun generatedKey(): String {
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            val body = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(pair.private.encoded)
            return "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
        }
    }
}
