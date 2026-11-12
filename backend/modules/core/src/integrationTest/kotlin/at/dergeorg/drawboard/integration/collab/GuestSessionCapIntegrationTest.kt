package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals

/**
 * The cap of guest sessions per address (S2.5): guests are cheap to make, so an address may hold only so many. The cap is
 * turned down to 2 here; the sockets of the test come from one address (the loopback), signed-in users are not counted.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "collab.max-guest-sessions-per-ip=2",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class GuestSessionCapIntegrationTest(private val client: WebTestClient, @LocalServerPort private val port: Int) {

    @Test
    fun `when more guests than the cap connect from one address then 429 for the next, and signed-in users are not counted`() =
        runBlocking {
        val owner = SharingUser(client, port, "Olga")
        val board = owner.createBoard()
        val created = owner.http().post().uri("/api/boards/{id}/links", board.id)
            .bodyValue(NewShareLink(GrantRole.VIEWER, ShareAudience.GUESTS, null, null)).exchange()
            .expectBody<CreatedShareLink>().returnResult().responseBody!!
        val token = created.url.substringAfter('#')
        val sessions = (1..3).map { n ->
            checkNotNull(
                client.post().uri("/api/shares/exchange").bodyValue(ShareExchange(token, null, "Guest $n")).exchange()
                    .expectBody<ShareAccess>().returnResult().responseBody?.guestSession,
            )
        }
        fun ticket(session: GuestSession) = checkNotNull(
            client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${session.accessToken}").build()
                .post().uri("/api/boards/${board.id}/collab-ticket").exchange().expectBody<CollabTicket>().returnResult().responseBody,
        ).ticket
        val firstTwo = sessions.take(2).map { TestSocket.connect(port, board.id.toString(), ticket(it)) }
        firstTwo.forEach { it.until(ServerFrame.SYNCED) }

        val third = client.get().uri("/api/boards/${board.id}/collab")
            .header(HttpHeaders.CONNECTION, "Upgrade").header(HttpHeaders.UPGRADE, "websocket")
            .header("Sec-WebSocket-Version", "13").header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header(HttpHeaders.ORIGIN, PUBLIC_URL).header("Sec-WebSocket-Protocol", "drawboard.v1, ticket.${ticket(sessions[2])}")
            .exchange().expectBody<String>().returnResult()

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, third.status, "the third guest from one address")
        owner.open(board).until(ServerFrame.SYNCED) // a signed-in user from the same address is fine
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { GuestIntegrationTest.generatedKey() }
        }
    }
}
