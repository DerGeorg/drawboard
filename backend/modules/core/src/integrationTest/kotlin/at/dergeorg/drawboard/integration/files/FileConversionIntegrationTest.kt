// The fake Gotenberg is a com.sun.net.httpserver (like the JWKS server of the other tests); it speaks java.net.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileConversion
import at.dergeorg.drawboard.contract.model.FileUrl
import at.dergeorg.drawboard.contract.model.FileUrlList
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.BeforeEach
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
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds

/**
 * The Office conversion (S4.10) against a FAKE Gotenberg - an HTTP server that answers like the sidecar (not the real
 * image): the asynchronous states, the PDF variant, and every way the sidecar can fail or misbehave.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/files-conversion-integration",
        "files.conversions-per-minute=1000",
        "files.uploads-per-minute=1000",
        "files.max-bytes-per-user=4000", // a converted PDF counts: see the quota test below
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class FileConversionIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
) {

    /** One array for upload and comparison: a ZIP made twice differs in the entry times. */
    private val docx = Bytes.docx()

    @BeforeEach
    fun reset() {
        FakeGotenberg.status = 200
        FakeGotenberg.body = FakeGotenberg.PDF
        FakeGotenberg.requests.clear()
    }

    private fun user(name: String) = SharingUser(client, port, name)

    private fun uploadDocx(owner: SharingUser, board: Board, name: String = "Quarterly report.docx"): BoardFile {
        val result = owner.upload(client, board.id, name, docx)
        assertEquals(HttpStatus.CREATED, result.status, "upload: ${result.responseBody}")
        return json.readValue(checkNotNull(result.responseBody), BoardFile::class.java)
    }

    /** Polls getFile like a client does: until the conversion left PENDING. */
    private fun settle(owner: SharingUser, board: Board, file: BoardFile): BoardFile = runBlocking {
        repeat(100) {
            val current = checkNotNull(
                owner.http().get().uri(
                    "/api/boards/{b}/files/{f}",
                    board.id,
                    file.id,
                ).exchange().expectBody<BoardFile>().returnResult().responseBody,
            )
            if (current.conversion != BoardFileConversion.PENDING) return@runBlocking current
            delay(100.milliseconds)
        }
        error("the conversion never left PENDING")
    }

    @Test
    fun `when a document is uploaded then it is PENDING at once and DONE after the sidecar answered - and the pdf is served`() {
        val owner = user("Olga")
        val board = owner.createBoard()

        val uploaded = uploadDocx(owner, board)
        val converted = settle(owner, board, uploaded)

        assertEquals(BoardFileConversion.PENDING, uploaded.conversion, "answered at once, the PDF is made asynchronously")
        assertEquals(BoardFileConversion.DONE, converted.conversion, "poll getFile until DONE")
        val urls: FileUrl = checkNotNull(
            owner.http().get().uri("/api/boards/{id}/files/urls?ids={f}", board.id, uploaded.id).exchange().expectBody<FileUrlList>()
                .returnResult().responseBody?.items?.single(),
        )
        val pdf = client.get().uri(checkNotNull(urls.pdfUrl)).exchange().expectBody<ByteArray>().returnResult()
        assertContentEquals(FakeGotenberg.PDF, pdf.responseBody, "the converted pdf")
        assertEquals("application/pdf", pdf.responseHeaders.contentType?.toString(), "type of the variant")
        assertEquals(urls.pdfUrl, urls.url, "the url a block displays is the pdf")
        val original = client.get().uri(urls.originalUrl).exchange().expectBody<ByteArray>().returnResult()
        assertContentEquals(docx, original.responseBody, "the original stays downloadable")
        assertTrue(
            checkNotNull(original.responseHeaders.getFirst("Content-Disposition")).startsWith("attachment;"),
            "as attachment (S4.11)",
        )
    }

    @Test
    fun `when the sidecar is called then only the convert route is used, with the detected extension - never the client's file name`() {
        val owner = user("Olga")
        val board = owner.createBoard()

        settle(owner, board, uploadDocx(owner, board, name = "../../evil \"name\".docx"))

        val request = FakeGotenberg.requests.single()
        assertEquals("/forms/libreoffice/convert", request.path, "the one route")
        assertTrue(
            "filename=\"document.docx\"" in request.body,
            "the extension tells the import filter, the name is fixed: ${request.body.take(300)}",
        )
        assertTrue("evil" !in request.body, "nothing the client chose reaches the sidecar")
    }

    @Test
    fun `when the sidecar fails then the file is FAILED and still downloadable`() {
        FakeGotenberg.status = 500
        val owner = user("Olga")
        val board = owner.createBoard()

        val converted = settle(owner, board, uploadDocx(owner, board))

        assertEquals(BoardFileConversion.FAILED, converted.conversion, "failed")
        val urls = checkNotNull(
            owner.http().get().uri("/api/boards/{id}/files/urls?ids={f}", board.id, converted.id).exchange().expectBody<FileUrlList>()
                .returnResult().responseBody?.items?.single(),
        )
        assertEquals(null, urls.pdfUrl, "no pdf variant")
        assertEquals(urls.originalUrl, urls.url, "the block shows a download card for the original")
        assertEquals(
            HttpStatus.OK,
            client.get().uri(urls.originalUrl).exchange().expectBody<ByteArray>().returnResult().status,
            "the original works",
        )
    }

    @Test
    fun `when a document was converted then its PDF counts against the quota of the user, not only the original`() {
        FakeGotenberg.body = "%PDF-1.7\n".toByteArray() + ByteArray(3_900) { 'x'.code.toByte() }
        val owner = user("Olga")
        val board = owner.createBoard()
        val converted = settle(owner, board, uploadDocx(owner, board))
        assertEquals(BoardFileConversion.DONE, converted.conversion, "the big PDF was made")
        assertTrue(docx.size < 1_000, "the original alone is far below the quota of 4000: ${docx.size}")

        val result = owner.upload(client, board.id, "plan.png", Bytes.png())

        assertEquals(HttpStatus.CONTENT_TOO_LARGE, result.status, "original + PDF are over the quota: ${result.responseBody}")
        assertTrue("FILES_QUOTA_EXCEEDED" in checkNotNull(result.responseBody), "the quota code: ${result.responseBody}")
        assertTrue("USER" in checkNotNull(result.responseBody), "of the user: ${result.responseBody}")
    }

    @Test
    fun `when the sidecar answers something that is not a pdf then the conversion fails`() {
        FakeGotenberg.body = "<html><script>alert(1)</script></html>".toByteArray()
        val owner = user("Olga")
        val board = owner.createBoard()

        val converted = settle(owner, board, uploadDocx(owner, board))

        assertEquals(BoardFileConversion.FAILED, converted.conversion, "sniffed as PDF or nothing")
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GOTENBERG_URL") { "http://127.0.0.1:${FakeGotenberg.port}" }
        }
    }
}

/** A stand-in for Gotenberg: answers `POST /forms/libreoffice/convert` with what the test set. Records what it received. */
object FakeGotenberg {
    val PDF: ByteArray = "%PDF-1.7\n% converted by the fake gotenberg\n%%EOF\n".toByteArray()

    class Request(val path: String, val body: String)

    @Volatile
    var status: Int = 200

    @Volatile
    var body: ByteArray = PDF

    val requests = CopyOnWriteArrayList<Request>()

    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { exchange ->
            val received = exchange.requestBody.readAllBytes().toString(Charsets.ISO_8859_1)
            requests += Request(exchange.requestURI.path, received)
            val answer = if (status == 200) body else "boom".toByteArray()
            exchange.responseHeaders.add("Content-Type", if (status == 200) "application/pdf" else "text/plain")
            exchange.sendResponseHeaders(status, answer.size.toLong())
            exchange.responseBody.use { it.write(answer) }
        }
        start()
        Runtime.getRuntime().addShutdownHook(Thread { stop(0) })
    }

    val port: Int get() = server.address.port
}
