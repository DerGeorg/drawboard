package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
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
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals

/** A file larger than `clamav-max-bytes` under fail closed (S4.12): 413 with the scanner's limit, not a 5xx, and no "unavailable" count. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/scanner-too-large-integration",
        "files.clamav-host=127.0.0.1",
        "files.clamav-connect-timeout-seconds=1",
        "files.clamav-fail-closed=true",
        "files.clamav-max-bytes=50", // below every PNG
        "files.uploads-per-minute=1000",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class FileScannerTooLargeIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val meters: MeterRegistry,
) {

    @Test
    fun `when a file is larger than the scanner takes and the policy is closed then 413 PAYLOAD_TOO_LARGE with the scanner's limit`() {
        val owner = SharingUser(client, port, "Large Olga")
        val board = owner.createBoard()
        val unavailable = meters.find("drawboard.scans").tag("result", "unavailable").counter()?.count() ?: 0.0

        val result = owner.upload(client, board.id, "plan.png", Bytes.png(40, 30))

        assertEquals(HttpStatus.CONTENT_TOO_LARGE, result.status, "refused, body ${result.responseBody}")
        val error = json.readValue(checkNotNull(result.responseBody), ErrorModel::class.java)
        assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, error.code, "error code")
        assertEquals(mapOf("limit" to "50"), error.params, "the limit is clamav-max-bytes")
        val files = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
        assertEquals(emptyList(), files.responseBody?.items, "nothing visible")
        assertEquals(1.0, meters.find("drawboard.scans").tag("result", "too_large").counter()?.count(), "scan counter")
        val unavailableNow = meters.find("drawboard.scans").tag("result", "unavailable").counter()?.count() ?: 0.0
        assertEquals(unavailable, unavailableNow, "not a scanner failure")
    }

    companion object {
        private val fake = FakeClamdServer()

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("files.clamav-port") { fake.port } // never reached: the file is not sent
        }
    }
}
