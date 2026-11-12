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
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import java.net.ServerSocket
import kotlin.test.assertEquals

/** The policy "fail closed" (S4.12): with `DRAWBOARD_CLAMAV_FAIL_CLOSED=true` and nobody listening on the clamd port, no upload gets in. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/scanner-closed-integration",
        "files.clamav-host=127.0.0.1",
        "files.clamav-connect-timeout-seconds=1",
        "files.clamav-fail-closed=true",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class FileScannerFailClosedIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val meters: MeterRegistry,
) {

    @Test
    fun `when clamd is down and the policy is closed then the upload is refused with 503 and Retry-After, and nothing becomes visible`() {
        val owner = SharingUser(client, port, "Closed Olga")
        val board = owner.createBoard()

        val result = owner.upload(client, board.id, "plan.png", Bytes.png(40, 30))

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, result.status, "refused, body ${result.responseBody}")
        assertEquals("30", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        assertEquals(ErrorCode.INTERNAL_ERROR, json.readValue(checkNotNull(result.responseBody), ErrorModel::class.java).code, "error code")
        val files = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
        assertEquals(emptyList(), files.responseBody?.items, "nothing visible")
        assertEquals(1.0, meters.find("drawboard.uploads").tag("result", "scan_failed").counter()?.count(), "upload counter")
        assertEquals(1.0, meters.find("drawboard.scans").tag("result", "unavailable").counter()?.count(), "scan counter")
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("files.clamav-port") { ServerSocket(0).use { it.localPort } } // a port nobody listens on
        }
    }
}
