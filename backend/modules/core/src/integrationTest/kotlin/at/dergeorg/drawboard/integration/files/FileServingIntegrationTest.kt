package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.FileUrl
import at.dergeorg.drawboard.contract.model.FileUrlList
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
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
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Clock

/**
 * The delivery of file bytes through signed URLs (S4.4, S4.5, S4.7): no token, the signature decides. Headers, the
 * single range, the order 400/403/404, and what a thumbnail and a JPEG original look like after upload (S4.8).
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/files-serving-integration",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class FileServingIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
) {

    private fun user(name: String) = SharingUser(client, port, name)

    private fun upload(owner: SharingUser, board: Board, name: String, bytes: ByteArray): BoardFile {
        val result = owner.upload(client, board.id, name, bytes)
        assertEquals(HttpStatus.CREATED, result.status, "upload of $name: ${result.responseBody}")
        return json.readValue(checkNotNull(result.responseBody), BoardFile::class.java)
    }

    private fun urlsOf(owner: SharingUser, board: Board, file: BoardFile): FileUrl =
        checkNotNull(
            owner.http().get().uri("/api/boards/{id}/files/urls?ids={f}", board.id, file.id).exchange()
                .expectBody<FileUrlList>().returnResult().responseBody?.items?.single(),
        ) { "no url for ${file.id}" }

    /** A request WITHOUT any token: the signature in the URL is all there is. */
    private fun fetch(url: String, range: String? = null) =
        client.get().uri(
            url,
        ).apply { if (range != null) header(HttpHeaders.RANGE, range) }.exchange().expectBody<ByteArray>().returnResult()

    /** Signs like the application does, with the key of the integration tests: lets a test forge URLs the server must refuse. */
    private fun sign(fileId: Any, variant: String, exp: Long, key: ByteArray = KEY): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal("$fileId|$variant|$exp".toByteArray()))
    }

    @Nested
    inner class Serving {

        @Test
        fun `when fetching a signed url without any token then 200 with the bytes and the headers of S4_5`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val pdf = Bytes.pdf()
            val file = upload(owner, board, "plan Ü.pdf", pdf)

            val result = fetch(urlsOf(owner, board, file).url)

            assertEquals(HttpStatus.OK, result.status, "status")
            assertContentEquals(pdf, result.responseBody, "the stored bytes")
            val headers = result.responseHeaders
            assertEquals("application/pdf", headers.contentType?.toString(), "detected media type")
            assertEquals("nosniff", headers.getFirst("X-Content-Type-Options"), "nosniff")
            assertEquals("default-src 'none'; sandbox", headers.getFirst("Content-Security-Policy"), "csp")
            assertEquals("private, max-age=3600", headers.getFirst(HttpHeaders.CACHE_CONTROL), "cache control")
            assertEquals("same-origin", headers.getFirst("Cross-Origin-Resource-Policy"), "corp")
            assertEquals("bytes", headers.getFirst(HttpHeaders.ACCEPT_RANGES), "ranges")
            val disposition = checkNotNull(headers.getFirst(HttpHeaders.CONTENT_DISPOSITION))
            assertTrue(
                disposition.startsWith("attachment;") && "filename*=UTF-8''plan%20%C3%9C.pdf" in disposition,
                "attachment, RFC 5987: $disposition",
            )
            assertEquals(pdf.size.toLong(), headers.contentLength, "length")
        }

        @Test
        fun `when fetching an image then it is inline`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.png", Bytes.png())

            val result = fetch(urlsOf(owner, board, file).url)

            assertTrue(
                checkNotNull(result.responseHeaders.getFirst(HttpHeaders.CONTENT_DISPOSITION)).startsWith("inline;"),
                "images are shown in the page",
            )
            assertEquals("image/png", result.responseHeaders.contentType?.toString(), "type")
        }

        @Test
        fun `when asking for one range then 206 with Content-Range and exactly those bytes`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val pdf = Bytes.pdf()
            val url = urlsOf(owner, board, upload(owner, board, "a.pdf", pdf)).url

            val middle = fetch(url, "bytes=2-9")
            val open = fetch(url, "bytes=${pdf.size - 5}-")
            val suffix = fetch(url, "bytes=-4")

            assertEquals(HttpStatus.PARTIAL_CONTENT, middle.status, "206")
            assertContentEquals(pdf.copyOfRange(2, 10), middle.responseBody, "bytes 2-9")
            assertEquals("bytes 2-9/${pdf.size}", middle.responseHeaders.getFirst(HttpHeaders.CONTENT_RANGE), "Content-Range")
            assertEquals(8L, middle.responseHeaders.contentLength, "length of the part")
            assertEquals("nosniff", middle.responseHeaders.getFirst("X-Content-Type-Options"), "the headers are on a 206 too")
            assertContentEquals(pdf.copyOfRange(pdf.size - 5, pdf.size), open.responseBody, "open range")
            assertContentEquals(pdf.copyOfRange(pdf.size - 4, pdf.size), suffix.responseBody, "suffix range")
        }

        @Test
        fun `when the range is bad then 416 with the size, and more than one range is refused too`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val pdf = Bytes.pdf()
            val url = urlsOf(owner, board, upload(owner, board, "a.pdf", pdf)).url

            listOf("bytes=${pdf.size + 10}-", "bytes=0-1,4-5", "bytes=9-3", "garbage").forEach { header ->
                val result = client.get().uri(url).header(HttpHeaders.RANGE, header).exchange().expectBody<ErrorModel>().returnResult()

                assertEquals(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, result.status, "range $header")
                assertEquals(ErrorCode.FILES_RANGE_NOT_SATISFIABLE, result.responseBody?.code, "code for $header")
                assertEquals("bytes */${pdf.size}", result.responseHeaders.getFirst(HttpHeaders.CONTENT_RANGE), "size in Content-Range")
            }
        }

        @Test
        fun `when the Accept header does not match the stored type then the file is served anyway - there is no 406`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val url = urlsOf(owner, board, upload(owner, board, "a.png", Bytes.png())).url

            val result = client.get().uri(
                url,
            ).header(HttpHeaders.ACCEPT, "application/json").exchange().expectBody<ByteArray>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "stored type whatever Accept says")
        }
    }

    @Nested
    inner class Verification {

        @Test
        fun `when the signature, the variant or the expiry is wrong then 403 FILES_URL_INVALID - always the same body`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.png", Bytes.png())
            val now = Clock.System.now().epochSeconds

            val tampered = "/files/${file.id}?v=original&exp=${now + 600}&sig=${"A".repeat(43)}"
            val otherVariant = "/files/${file.id}?v=thumbnail&exp=${now + 600}&sig=${sign(file.id, "original", now + 600)}"
            val expired = "/files/${file.id}?v=original&exp=${now - 5}&sig=${sign(file.id, "original", now - 5)}"
            val tooFar = "/files/${file.id}?v=original&exp=${now + 86_400}&sig=${sign(file.id, "original", now + 86_400)}"
            val foreignSignature = sign(file.id, "original", now + 600, ByteArray(40) { 5 })
            val retiredKey = "/files/${file.id}?v=original&exp=${now + 600}&sig=$foreignSignature"

            val bodies = listOf(tampered, otherVariant, expired, tooFar, retiredKey).map { url ->
                val result = client.get().uri(url).exchange().expectBody<ErrorModel>().returnResult()
                assertEquals(HttpStatus.FORBIDDEN, result.status, "403 for $url")
                assertEquals(ErrorCode.FILES_URL_INVALID, result.responseBody?.code, "code")
                assertEquals(
                    null,
                    result.responseHeaders.getFirst(HttpHeaders.WWW_AUTHENTICATE),
                    "no challenge: this is not a login problem",
                )
                result.responseBody?.let { it.code to it.detail to it.title }
            }
            assertEquals(1, bodies.toSet().size, "one body for every reason (S4.4)")
        }

        @Test
        fun `when parameters are missing or malformed then 400`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.png", Bytes.png())

            listOf(
                "/files/${file.id}",
                "/files/${file.id}?v=original&exp=1",
                "/files/${file.id}?v=nonsense&exp=1&sig=${"A".repeat(43)}",
                "/files/${file.id}?v=original&exp=abc&sig=${"A".repeat(43)}",
                "/files/${file.id}?v=original&exp=1&sig=short",
                "/files/not-a-uuid?v=original&exp=1&sig=${"A".repeat(43)}",
            ).forEach { url ->
                val result = client.get().uri(url).exchange().expectBody<ErrorModel>().returnResult()
                assertEquals(HttpStatus.BAD_REQUEST, result.status, "400 for $url")
            }
        }

        @Test
        fun `when the url is valid but the file was deleted then 404 - only a valid signature learns that`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.png", Bytes.png())
            val url = urlsOf(owner, board, file).url
            owner.status("DELETE", "/api/boards/${board.id}/files/${file.id}")

            val result = client.get().uri(url).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(
                HttpStatus.NOT_FOUND to ErrorCode.FILES_FILE_NOT_FOUND,
                result.status to result.responseBody?.code,
                "deleted since",
            )
        }

        @Test
        fun `when a variant does not exist then a valid url answers 404`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.pdf", Bytes.pdf())
            val exp = Clock.System.now().epochSeconds + 600

            val result = client.get().uri("/files/${file.id}?v=thumbnail&exp=$exp&sig=${sign(file.id, "thumbnail", exp)}").exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, result.responseBody?.code, "a pdf has no thumbnail")
        }

        @Test
        fun `when the method is not GET then the route is not open`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "a.png", Bytes.png())
            val url = urlsOf(owner, board, file).url

            val post = client.post().uri(url).exchange().expectBody<String>().returnResult()
            val delete = client.delete().uri(url).exchange().expectBody<String>().returnResult()

            assertEquals(
                listOf(HttpStatus.UNAUTHORIZED, HttpStatus.UNAUTHORIZED),
                listOf(post.status, delete.status),
                "denyAll for everything but GET",
            )
        }
    }

    @Nested
    inner class Images {

        @Test
        fun `when an image is uploaded then it has a thumbnail variant of at most 512 pixels`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = upload(owner, board, "big.jpg", Bytes.jpeg(1600, 900))

            val urls = urlsOf(owner, board, file)
            val thumbnail = fetch(checkNotNull(urls.thumbnailUrl) { "an image has a thumbnail url" })

            assertEquals(HttpStatus.OK, thumbnail.status, "thumbnail")
            assertEquals("image/jpeg", thumbnail.responseHeaders.contentType?.toString(), "re-encoded")
            val image = checkNotNull(javax.imageio.ImageIO.read(thumbnail.responseBody!!.inputStream()))
            assertEquals(512 to 288, image.width to image.height, "scaled down, aspect ratio kept")
            assertTrue((thumbnail.responseBody?.size ?: Int.MAX_VALUE) < Bytes.jpeg(1600, 900).size, "smaller than the original")
        }

        @Test
        fun `when a JPEG carries EXIF and GPS then the stored original has none, and the picture still decodes`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val withExif = Bytes.jpegWithExif(48, 32)
            assertTrue("GPS: 48.2082N" in String(withExif, Charsets.ISO_8859_1), "the fixture carries a location")

            val file = upload(owner, board, "photo.jpg", withExif)
            val stored = fetch(urlsOf(owner, board, file).originalUrl)

            assertTrue("GPS" !in String(checkNotNull(stored.responseBody), Charsets.ISO_8859_1), "location removed from the original")
            assertNotNull(javax.imageio.ImageIO.read(stored.responseBody!!.inputStream()), "still a valid image")
            val meta = owner.http().get().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<BoardFile>().returnResult().responseBody
            assertEquals(stored.responseBody!!.size.toLong(), meta?.size, "the size is that of the stored file")
            assertEquals(48 to 32, meta?.width to meta?.height, "dimensions")
        }
    }

    companion object {
        /** The key of the integration tests (src/integrationTest/resources/application.properties). */
        private val KEY = "integration-test-file-url-key-0123456789".toByteArray()

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
