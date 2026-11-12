package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.contract.model.BoardVersionList
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
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
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Versions (S2.8): the owner lists the kept snapshots and restores one. Restoring closes every session with 4410, and
 * whoever joins next gets the restored drawing as the new base - with nothing of the old log after it.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "collab.compaction-entries=3",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class VersionsIntegrationTest(private val client: WebTestClient, @LocalServerPort private val port: Int) {

    private fun user(name: String) = SharingUser(client, port, name)

    private fun update(vararg payload: Int) = byteArrayOf(0x01) + ByteArray(payload.size) { payload[it].toByte() }

    private fun upload(owner: SharingUser, boardId: Uuid, upToSeq: Long, bytes: ByteArray) =
        owner.http().put().uri("/api/boards/$boardId/snapshot?upToSeq=$upToSeq")
            .multipartForm("snapshot", bytes, "s.bin")
            .exchange().expectBody<String>().returnResult()

    private fun versions(owner: SharingUser, boardId: Uuid) = checkNotNull(
        owner.http().get().uri("/api/boards/$boardId/versions").exchange().expectBody<BoardVersionList>().returnResult().responseBody,
    ).items

    @Nested
    inner class Restore {

        @Test
        fun `when the owner restores a version then sessions close with 4410 and the next join starts from the restored base`() =
            runBlocking {
            val owner = user("Olga")
            val board = owner.createBoard()
            val editor = owner.open(board)
            editor.until(ServerFrame.SYNCED)
            repeat(4) { editor.send(update(it)) }
            val upToSeq = editor.until(ServerFrame.COMPACT).last().varUint()
            assertEquals(HttpStatus.NO_CONTENT, upload(owner, board.id, upToSeq, byteArrayOf(5, 6)).status,
                "snapshot of the drawing so far")
            editor.send(update(99))
            editor.until(ServerFrame.ACK)
            val listed = versions(owner, board.id)
            assertEquals(listOf(upToSeq), listed.map { it.upToSeq }, "one version")

            val restore = owner.http().post().uri("/api/boards/${board.id}/versions/${listed.single().id}/restore").exchange()
                .expectBody<String>().returnResult()

            assertEquals(HttpStatus.NO_CONTENT, restore.status, "restored")
            assertEquals(4410, editor.closeStatus().code, "document replaced")
            val joiner = owner.open(board).until(ServerFrame.SYNCED)
            assertEquals(
                listOf(ServerFrame.WELCOME, ServerFrame.SNAPSHOT, ServerFrame.SYNCED),
                joiner.map { it.type },
                "the restored base and nothing of the old log",
            )
            assertTrue(joiner[1].varUint() > 5L, "a new epoch: the base lies above every old sequence number")
            assertContentEquals(byteArrayOf(5, 6), joiner[1].rest(), "the restored drawing")
            assertEquals(2, versions(owner, board.id).size, "the restored base is a version, the old one stays listed")
        }

        @Test
        fun `when an editor or a stranger asks for the versions then 403 and 404, and an unknown version is 404`() {
            val owner = user("Olga")
            val editor = user("Edda")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)

            assertEquals(HttpStatus.FORBIDDEN, editor.status("GET", "/api/boards/${board.id}/versions"), "an editor is not the owner")
            assertEquals(HttpStatus.NOT_FOUND, stranger.status("GET", "/api/boards/${board.id}/versions"), "a stranger knows nothing")
            assertEquals(HttpStatus.FORBIDDEN, editor.status("POST", "/api/boards/${board.id}/versions/${Uuid.random()}/restore"),
                "restore: owner only")
            val unknown = owner.http().post().uri("/api/boards/${board.id}/versions/${Uuid.random()}/restore").exchange()
                .expectBody<ErrorModel>().returnResult()
            assertEquals(ErrorCode.COLLAB_VERSION_NOT_FOUND, unknown.responseBody?.code, "an unknown version")
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
