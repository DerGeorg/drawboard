package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.files.domain.files.model.FileRejected
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.paging.PageQuery
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The malware scan of uploads end to end (S4.12) against a fake clamd on a loopback port: clean files become visible, infected
 * ones are refused with 415 and an audit event, and a scanner that is down is a counted non-event while the policy is "open" (the
 * default). The last test stops the fake, so it runs last.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/scanner-integration",
        "files.clamav-host=127.0.0.1",
        "files.clamav-connect-timeout-seconds=1",
        "files.uploads-per-minute=1000",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class FileScannerIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val meters: MeterRegistry,
    private val auditLog: AuditLog,
) {

    private fun count(name: String, result: String) = meters.find(name).tag("result", result).counter()?.count() ?: 0.0

    private fun list(user: SharingUser, boardId: kotlin.uuid.Uuid) =
        user.http().get().uri("/api/boards/{id}/files", boardId).exchange().expectBody<BoardFileList>().returnResult().responseBody!!.items

    @Test
    @Order(1)
    fun `when a file is clean then it is stored and visible, and clamd got exactly its bytes`() {
        val owner = SharingUser(client, port, "Scan Olga")
        val board = owner.createBoard()
        val png = Bytes.png(40, 30)
        val clean = count("drawboard.scans", "clean")

        val result = owner.upload(client, board.id, "plan.png", png)

        assertEquals(HttpStatus.CREATED, result.status, "stored, body ${result.responseBody}")
        val file = json.readValue(checkNotNull(result.responseBody), BoardFile::class.java)
        assertEquals(listOf(file.id), list(owner, board.id).map { it.id }, "visible")
        assertTrue(fake.streams.any { it.contentEquals(png) }, "clamd was sent the uploaded bytes unchanged")
        assertEquals(clean + 1, count("drawboard.scans", "clean"), "scan counter")
    }

    @Test
    @Order(2)
    fun `when a file is infected then 415 without the signature, nothing is visible, and the audit trail names it`() {
        val owner = SharingUser(client, port, "Scan Olga")
        val board = owner.createBoard()
        val infected = Bytes.png(40, 30) + EICAR.toByteArray()

        val result = owner.upload(client, board.id, "invoice.png", infected)

        assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, result.status, "refused")
        val error = json.readValue(checkNotNull(result.responseBody), ErrorModel::class.java)
        assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.code, "code")
        assertFalse(result.responseBody!!.contains("EICAR"), "the client is not told the signature: ${result.responseBody}")
        assertEquals(emptyList(), list(owner, board.id), "nothing became visible")
        val rejected = runBlocking {
            auditLog.find(AuditFilter(module = "files", eventTypes = setOf("files.file.rejected")), PageQuery(0, 50)).items
        }.mapNotNull { it.detailsAs<FileRejected>() }.single { it.boardId == board.id.toString() }
        assertEquals("Win.Test.EICAR_HDB-1" to "INFECTED", rejected.signature to rejected.reason, "audit details")
        assertTrue(count("drawboard.scans", "infected") >= 1.0, "scan counter")
        assertTrue(count("drawboard.uploads", "infected") >= 1.0, "upload counter")
    }

    @Test
    @Order(3)
    fun `when clamd is down and the policy is open then the upload is accepted and the unscanned file is counted`() {
        val owner = SharingUser(client, port, "Scan Olga")
        val board = owner.createBoard()
        fake.stop()
        val unavailable = count("drawboard.scans", "unavailable")

        val result = owner.upload(client, board.id, "plan.png", Bytes.png(40, 30))

        assertEquals(HttpStatus.CREATED, result.status, "accepted although it could not be scanned (fail open)")
        assertEquals(1, list(owner, board.id).size, "visible")
        assertEquals(unavailable + 1, count("drawboard.scans", "unavailable"), "counted")
    }

    companion object {
        private val fake = FakeClamdServer()

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("files.clamav-port") { fake.port }
        }
    }
}
