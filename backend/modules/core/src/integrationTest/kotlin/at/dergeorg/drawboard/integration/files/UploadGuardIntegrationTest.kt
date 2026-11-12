package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.core.infra.web.SpoolDirectory
import at.dergeorg.drawboard.core.infra.web.UploadGuard
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import org.junit.jupiter.api.Nested
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
import org.springframework.test.web.reactive.server.EntityExchangeResult
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import java.net.Socket
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The upload guard (M3 backend review, MUST 1): `POST /api/boards/{id}/files`, `PUT /api/boards/{id}/snapshot` and
 * `POST /api/admin/plugins` are refused from their headers - no Content-Length (411), above the cap of the route (413), too many
 * at once or too many per minute (429) - BEFORE Spring's multipart reader spools a byte, and after authentication (a stranger
 * gets 401, not 413). The caps are turned down in the properties so a refused body is a few hundred kilobytes; the spool
 * directory is a directory of its own, which stays empty.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_ADMIN_GROUP=drawboard-admins",
        "DRAWBOARD_FILES_DIR=build/files-upload-guard",
        "DRAWBOARD_UPLOAD_SPOOL_DIR=build/spool-upload-guard",
        "files.max-file-bytes=20000",
        "files.max-video-bytes=60000",
        "collab.max-snapshot-bytes=30000",
        "app.uploads.max-plugin-bytes=40000",
        "app.uploads.envelope-bytes=2000",
        "app.uploads.per-user-per-minute=6",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
internal class UploadGuardIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val guard: UploadGuard,
    private val spool: SpoolDirectory,
) {

    private fun user(name: String = "Una") = SharingUser(client, port, name)

    private fun admin() = SharingUser(client, port, "Ada", listOf("drawboard-admins"))

    private fun spooled(): List<Path> = spool.leftovers()

    private fun problem(result: EntityExchangeResult<String>): ErrorModel =
        json.readValue(checkNotNull(result.responseBody) { "empty body" }, ErrorModel::class.java)

    private fun filesUpload(token: String?, boardId: Any, bytes: ByteArray) =
        client.post().uri("/api/boards/{id}/files", boardId)
            .apply { if (token != null) header(HttpHeaders.AUTHORIZATION, "Bearer $token") }
            .multipartForm("file", bytes, "a.png").exchange().expectBody<String>().returnResult()

    @Nested
    inner class Setup {

        @Test
        fun `when the spool directory is configured then it is the one Spring spools to, and it exists and is empty`() {
            val expected = Path.of("build/spool-upload-guard").toAbsolutePath().normalize()

            assertEquals(expected, spool.path.toAbsolutePath().normalize(), "configured")
            assertTrue(Files.isDirectory(spool.path), "created at the start")
            assertEquals(emptyList(), spooled(), "nothing left over")
        }
    }

    @Nested
    inner class TooLarge {

        @Test
        fun `when a file upload declares more than the video cap then 413 PAYLOAD_TOO_LARGE, nothing is spooled and no file is stored`() {
            val owner = user()
            val board = owner.createBoard()

            val result = filesUpload(owner.token, board.id, ByteArray(120_000) { 1 })

            val error = problem(result)
            assertEquals(HttpStatus.CONTENT_TOO_LARGE, result.status, "413 before the body is read")
            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, error.code, "the existing code")
            assertEquals(emptyList(), spooled(), "the spool directory stayed empty")
            val files = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<String>().returnResult()
            assertTrue(checkNotNull(files.responseBody).contains("\"items\":[]"), "the handler never ran: ${files.responseBody}")
        }

        @Test
        fun `when a snapshot upload is above the snapshot cap then 413, and a plugin above its cap too`() {
            val owner = user()
            val board = owner.createBoard()

            val snapshot = owner.http().put().uri("/api/boards/${board.id}/snapshot?upToSeq=1")
                .multipartForm("snapshot", ByteArray(60_000)).exchange().expectBody<String>().returnResult()
            val plugin = admin().http().post().uri("/api/admin/plugins")
                .multipartForm("file", ByteArray(60_000)).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.CONTENT_TOO_LARGE, snapshot.status, "snapshot: cap 30000 + envelope")
            assertEquals(HttpStatus.CONTENT_TOO_LARGE, plugin.status, "plugin: cap 40000 + envelope")
            assertEquals(emptyList(), spooled(), "the spool directory stayed empty")
        }

        @Test
        fun `when an upload is within the cap of its route then it passes the guard`() {
            val owner = user()
            val board = owner.createBoard()

            val result = filesUpload(owner.token, board.id, Bytes.png(20, 20))

            assertEquals(HttpStatus.CREATED, result.status, "a normal upload carries a Content-Length: ${result.responseBody}")
            assertEquals(0, guard.inFlight, "the slot is back")
        }
    }

    @Nested
    inner class BeforeTheBody {

        @Test
        fun `when nobody is signed in then an oversized upload is 401, not 413 - the guard runs after authentication`() {
            val board = user().createBoard()

            val result = filesUpload(null, board.id, ByteArray(120_000))

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "authentication first")
        }

        @Test
        fun `when a user who is no admin sends an oversized plugin then 403 from the route table, not 413`() {
            val result = user().http().post().uri("/api/admin/plugins")
                .multipartForm("file", ByteArray(120_000)).exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "the route table decides before the guard")
        }
    }

    @Nested
    inner class NoLength {

        @Test
        fun `when the upload has no Content-Length then 411`() {
            val owner = user()
            val board = owner.createBoard()

            val response = rawRequest(
                "POST /api/boards/${board.id}/files HTTP/1.1",
                owner.token,
                headers = listOf("Content-Type: multipart/form-data; boundary=xyz"),
                body = "",
            )

            assertEquals(411, response.status, "no length: ${response.text}")
            assertTrue(response.text.contains("application/problem+json"), "an RFC 9457 body: ${response.text}")
            assertEquals(emptyList(), spooled(), "nothing spooled")
        }

        @Test
        fun `when the upload is chunked then 411, however small it is`() {
            val owner = user()
            val board = owner.createBoard()

            val response = rawRequest(
                "POST /api/boards/${board.id}/files HTTP/1.1",
                owner.token,
                headers = listOf("Content-Type: multipart/form-data; boundary=xyz", "Transfer-Encoding: chunked"),
                body = "5\r\nhello\r\n0\r\n\r\n",
            )

            assertEquals(411, response.status, "chunked: ${response.text}")
            assertEquals(emptyList(), spooled(), "nothing spooled")
        }
    }

    @Nested
    inner class Limits {

        @Test
        fun `when a user has two uploads in flight then the third is 429 with Retry-After, and fine again after one ends`() {
            val owner = user()
            val board = owner.createBoard()
            val first = openUpload(owner, board.id.toString())
            val second = openUpload(owner, board.id.toString())
            try {
                awaitInFlight(2)

                val third = filesUpload(owner.token, board.id, Bytes.png())
                val other = user().let { filesUpload(it.token, it.createBoard().id, Bytes.png()) }

                assertEquals(HttpStatus.TOO_MANY_REQUESTS, third.status, "third concurrent upload of the same user: ${third.responseBody}")
                assertEquals(ErrorCode.TOO_MANY_REQUESTS, problem(third).code, "the existing 429 code")
                assertNotNull(third.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
                assertEquals(HttpStatus.CREATED, other.status, "another user is not affected")

                first.close()
                awaitInFlight(1)
                val again = filesUpload(owner.token, board.id, Bytes.png())
                assertEquals(HttpStatus.CREATED, again.status, "a place was freed when the first upload ended: ${again.responseBody}")
            } finally {
                first.close()
                second.close()
            }
            awaitInFlight(0)
        }

        @Test
        fun `when a user starts more uploads than the rate per minute then 429 before the body`() {
            val owner = user()
            val board = owner.createBoard()

            val statuses = (1..8).map { filesUpload(owner.token, board.id, Bytes.png(10 + it, 10)).status }

            assertEquals(List(6) { HttpStatus.CREATED }, statuses.take(6), "six are fine: $statuses")
            assertEquals(List(2) { HttpStatus.TOO_MANY_REQUESTS }, statuses.drop(6), "the seventh and eighth are refused: $statuses")
            assertEquals(0, guard.inFlight, "refused and finished uploads hold nothing")
        }
    }

    /** An upload that stays in flight: the headers promise a long body, only a few bytes of it ever arrive. */
    private fun openUpload(user: SharingUser, boardId: String): Socket {
        val socket = Socket("127.0.0.1", port)
        val head = "POST /api/boards/$boardId/files HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${user.token}\r\n" +
            "Content-Type: multipart/form-data; boundary=xyz\r\nContent-Length: 5000\r\n\r\n" +
            "--xyz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\nstart"
        socket.getOutputStream().apply {
            write(head.toByteArray())
            flush()
        }
        return socket
    }

    private fun awaitInFlight(expected: Int) {
        val deadline = System.nanoTime() + WAIT_NANOS
        while (guard.inFlight != expected && System.nanoTime() < deadline) Thread.sleep(POLL_MILLIS)
        assertEquals(expected, guard.inFlight, "uploads in flight")
    }

    private class Raw(val status: Int, val text: String)

    /** One HTTP/1.1 request exactly as written (no client in between that would add a length), the answer read until close. */
    private fun rawRequest(requestLine: String, token: String, headers: List<String>, body: String): Raw =
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = READ_TIMEOUT_MILLIS
            val head = (listOf(requestLine, "Host: localhost", "Authorization: Bearer $token", "Connection: close") + headers)
                .joinToString("\r\n", postfix = "\r\n\r\n")
            socket.getOutputStream().apply {
                write((head + body).toByteArray())
                flush()
            }
            val text = socket.getInputStream().readBytes().toString(Charsets.ISO_8859_1)
            Raw(text.substringAfter("HTTP/1.1 ").substringBefore(' ').toInt(), text)
        }

    companion object {
        private const val WAIT_NANOS = 10_000_000_000L
        private const val POLL_MILLIS = 25L
        private const val READ_TIMEOUT_MILLIS = 10_000

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
