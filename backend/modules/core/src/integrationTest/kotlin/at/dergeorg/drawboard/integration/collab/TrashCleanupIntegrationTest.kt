package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.web.reactive.server.expectBody
import at.dergeorg.drawboard.contract.model.Trash
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.milliseconds

/**
 * The scheduled cleanup (S7.7): retention 0 days and a one-second interval, so what is in the trash is purged within a
 * few seconds - the board, its folder entry, and the data of its drawing. (The real default is 30 days.)
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_TRASH_RETENTION_DAYS=0",
        "DRAWBOARD_TRASH_CLEANUP_SECONDS=1",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
// The job of this context purges EVERYTHING in the trash after 0 days: it must not outlive the class and meet other tests.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class TrashCleanupIntegrationTest(private val client: WebTestClient, @LocalServerPort private val port: Int) {

    @Test
    fun `when something has been in the trash longer than the retention then the job purges it for good, including its folder content`() =
        runBlocking {
            val owner = SharingUser(client, port, "Olga")
            val folder = owner.createFolder("Old stuff")
            val board = owner.createBoard("Gone soon", folder.id)
            val loose = owner.createBoard("Also gone")
            val kept = owner.createBoard("Stays")
            owner.status("DELETE", "/api/folders/${folder.id}")
            owner.status("DELETE", "/api/boards/${loose.id}")

            // the trash listing is a probe that changes nothing: wait until the job emptied it
            repeat(40) {
                val trash = owner.http().get().uri("/api/trash").exchange().expectBody<Trash>().returnResult().responseBody
                if (trash != null && trash.boards.isEmpty() && trash.folders.isEmpty()) return@repeat
                delay(250.milliseconds)
            }

            assertEquals(HttpStatus.NOT_FOUND, owner.status("POST", "/api/trash/boards/${loose.id}/restore"),
                "the board is purged: no longer restorable")
            assertEquals(HttpStatus.NOT_FOUND, owner.status("POST", "/api/trash/folders/${folder.id}/restore"), "so is the folder")
            assertEquals(HttpStatus.NOT_FOUND, owner.status("POST", "/api/trash/boards/${board.id}/restore"),
                "and the board that was in it")
            assertEquals(HttpStatus.OK, owner.status("GET", "/api/boards/${kept.id}"), "what was not deleted is untouched")
        }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun jwks(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
