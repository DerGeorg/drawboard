package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.BoardFileConversion
import at.dergeorg.drawboard.contract.model.BoardFileKind
import at.dergeorg.drawboard.contract.model.BoardFileList
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.FileUrlList
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.GuestIntegrationTest
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
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The files of a board end to end (S4): upload, type detection, caps, quotas, metadata, the roles on the board and the
 * guest allowlist, deletion and the purge with the board. Real signed tokens and PostgreSQL; the limits are turned down
 * in the properties so a cap or a quota is reached with a few bytes.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "DRAWBOARD_FILES_DIR=build/files-integration",
        "files.max-file-bytes=20000",
        "files.max-video-bytes=60000",
        "files.max-bytes-per-user=40000",
        "files.max-files-per-board=6",
        "files.uploads-per-minute=1000",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class FilesIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
) {

    private val root = Path.of("build/files-integration")

    private fun user(name: String) = SharingUser(client, port, name)

    private fun uploaded(user: SharingUser, board: Board, name: String, bytes: ByteArray): BoardFile {
        val result = user.upload(client, board.id, name, bytes)
        assertEquals(HttpStatus.CREATED, result.status, "uploading $name: ${result.responseBody}")
        return json.readValue(checkNotNull(result.responseBody), BoardFile::class.java)
    }

    private fun rejected(user: SharingUser, board: Board, name: String, bytes: ByteArray): Pair<HttpStatus, ErrorModel> {
        val result = user.upload(client, board.id, name, bytes)
        return HttpStatus.valueOf(
            result.status.value(),
        ) to json.readValue(checkNotNull(result.responseBody) { "empty body" }, ErrorModel::class.java)
    }

    private fun guestOf(owner: SharingUser, board: Board, role: GrantRole = GrantRole.VIEWER): WebTestClient {
        val created = owner.http().post().uri("/api/boards/${board.id}/links")
            .bodyValue(NewShareLink(role, ShareAudience.GUESTS, null, null)).exchange().expectBody<CreatedShareLink>().returnResult()
        val token = checkNotNull(created.responseBody).url.substringAfter('#')
        val access = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", "10.1.2.3")
            .bodyValue(ShareExchange(token, null, "Gus")).exchange().expectBody<ShareAccess>().returnResult().responseBody
        val session: GuestSession = checkNotNull(checkNotNull(access).guestSession)
        return client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${session.accessToken}").build()
    }

    @Nested
    inner class Upload {

        @Test
        fun `when an editor uploads a png then 201 with the metadata, a Location, and the file is listed and readable`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val result = owner.upload(client, board.id, "Plan A.png", Bytes.png(40, 30))

            assertEquals(HttpStatus.CREATED, result.status, "created, body ${result.responseBody}")
            val file = json.readValue(checkNotNull(result.responseBody), BoardFile::class.java)
            assertEquals("/api/boards/${board.id}/files/${file.id}", result.responseHeaders.location?.path, "Location")
            assertEquals(
                listOf("Plan A.png", "image/png", BoardFileKind.IMAGE, BoardFileConversion.NONE, 40, 30, owner.id),
                listOf(file.name, file.mediaType, file.kind, file.conversion, file.width, file.height, file.createdBy),
                "metadata: the type is the detected one",
            )
            val list = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
            assertEquals(listOf(file.id), list.responseBody?.items?.map { it.id }, "listed")
            val single = owner.http().get().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<BoardFile>().returnResult()
            assertEquals(file.id, single.responseBody?.id, "get")
            assertTrue(storedBlobs(root, file.id).isNotEmpty(), "the bytes are on the volume, under the id")
        }

        @Test
        fun `when the file is not what its name says then 415 FILES_TYPE_NOT_ALLOWED and nothing is stored`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val svg = rejected(owner, board, "logo.svg", Bytes.svg())
            val exe = rejected(owner, board, "holiday.png", Bytes.exe())
            val mismatch = rejected(owner, board, "photo.jpg", Bytes.png())

            listOf(svg, exe, mismatch).forEach { (status, error) ->
                assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, status, "type")
                assertEquals(ErrorCode.FILES_TYPE_NOT_ALLOWED, error.code, "code")
            }
            assertEquals("image/png", mismatch.second.params?.get("mediaType"), "the detected type is named")
            val list = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
            assertEquals(emptyList(), list.responseBody?.items, "nothing was stored")
        }

        @Test
        fun `when the file is larger than the cap then 413 PAYLOAD_TOO_LARGE with the limit and nothing is stored`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val (status, error) = rejected(owner, board, "big.pdf", Bytes.pdf() + ByteArray(30_000))

            assertEquals(HttpStatus.CONTENT_TOO_LARGE, status, "above 20000 bytes")
            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, error.code, "code")
            assertEquals("20000", error.params?.get("limit"), "the limit that applied")
            val list = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
            assertEquals(emptyList(), list.responseBody?.items, "nothing was stored")
        }

        @Test
        fun `when the user quota is used up then 413 FILES_QUOTA_EXCEEDED with scope USER`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            repeat(2) { uploaded(owner, board, "f$it.pdf", Bytes.pdf() + ByteArray(15_000)) }

            val (status, error) = rejected(owner, board, "one-too-many.pdf", Bytes.pdf() + ByteArray(15_000))

            assertEquals(HttpStatus.CONTENT_TOO_LARGE, status, "quota")
            assertEquals(ErrorCode.FILES_QUOTA_EXCEEDED, error.code, "code")
            assertEquals("USER", error.params?.get("scope"), "scope")
            assertEquals("40000", error.params?.get("limit"), "limit")
        }

        @Test
        fun `when the board holds its maximum number of files then 413 FILES_QUOTA_EXCEEDED with scope BOARD`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            repeat(6) { uploaded(owner, board, "f$it.png", Bytes.png()) }

            val (status, error) = rejected(owner, board, "f7.png", Bytes.png())

            assertEquals(HttpStatus.CONTENT_TOO_LARGE, status, "7th file")
            assertEquals("BOARD", error.params?.get("scope"), "scope")
        }

        @Test
        fun `when a form field named file is not a file then 400`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val result = owner.http().post().uri("/api/boards/{id}/files", board.id)
                .multipartForm("file", "just text".toByteArray(), filename = null)
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "not a file")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "code")
        }
    }

    @Nested
    inner class Roles {

        @Test
        fun `when a viewer uploads then 403 and a stranger gets 404 - the board's existence is not revealed`() {
            val owner = user("Olga")
            val viewer = user("Vera")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)

            val asViewer = rejected(viewer, board, "a.png", Bytes.png())
            val asStranger = rejected(stranger, board, "a.png", Bytes.png())

            assertEquals(HttpStatus.FORBIDDEN to ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, asViewer.first to asViewer.second.code, "viewer")
            assertEquals(HttpStatus.NOT_FOUND to ErrorCode.LIBRARY_BOARD_NOT_FOUND, asStranger.first to asStranger.second.code, "stranger")
        }

        @Test
        fun `when a viewer lists and reads then it works, and when a stranger lists then 404`() {
            val owner = user("Olga")
            val viewer = user("Vera")
            val stranger = user("Sam")
            val board = owner.createBoard()
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)
            val file = uploaded(owner, board, "a.png", Bytes.png())

            val read = viewer.http().get().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<BoardFile>().returnResult()
            val foreign = stranger.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.OK, read.status, "viewer reads")
            assertEquals(owner.id, read.responseBody?.createdBy, "a signed-in user sees who uploaded")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, foreign.responseBody?.code, "stranger")
        }

        @Test
        fun `when a file is asked through another board then 404 FILES_FILE_NOT_FOUND`() {
            val owner = user("Olga")
            val one = owner.createBoard()
            val two = owner.createBoard()
            val file = uploaded(owner, one, "a.png", Bytes.png())

            val result = owner.http().get().uri(
                "/api/boards/{b}/files/{f}",
                two.id,
                file.id,
            ).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND to ErrorCode.FILES_FILE_NOT_FOUND, result.status to result.responseBody?.code, "other board")
        }
    }

    @Nested
    inner class Guests {

        @Test
        fun `when a guest reads the files then it sees metadata without createdBy and can get urls, but cannot upload or delete`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = uploaded(owner, board, "a.png", Bytes.png())
            val guest = guestOf(owner, board, GrantRole.EDITOR)

            val list = guest.get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<BoardFileList>().returnResult()
            val single = guest.get().uri("/api/boards/{b}/files/{f}", board.id, file.id).exchange().expectBody<BoardFile>().returnResult()
            val urls = guest.get().uri(
                "/api/boards/{id}/files/urls?ids={f}",
                board.id,
                file.id,
            ).exchange().expectBody<FileUrlList>().returnResult()
            val upload = guest.post().uri("/api/boards/{id}/files", board.id).exchange().expectBody<ErrorModel>().returnResult()
            val delete = guest.delete().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.OK, list.status, "list")
            assertNull(list.responseBody?.items?.single()?.createdBy, "no user ids for guests")
            assertNull(single.responseBody?.createdBy, "no user id for guests")
            assertEquals(1, urls.responseBody?.items?.size, "urls")
            assertEquals(
                HttpStatus.FORBIDDEN to ErrorCode.FORBIDDEN,
                upload.status to upload.responseBody?.code,
                "a guest never uploads (S1.9), even with an EDITOR link",
            )
            assertEquals(HttpStatus.FORBIDDEN, delete.status, "nor deletes")
        }

        @Test
        fun `when a guest asks for the files of another board then 404`() {
            val owner = user("Olga")
            val shared = owner.createBoard()
            val other = owner.createBoard()
            val guest = guestOf(owner, shared)

            val result = guest.get().uri("/api/boards/{id}/files", other.id).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "only the board of the link")
        }
    }

    @Nested
    inner class Urls {

        @Test
        fun `when asking for urls then only files of this board are answered, in order, with no-store`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val other = owner.createBoard()
            val a = uploaded(owner, board, "a.png", Bytes.png())
            val b = uploaded(owner, board, "b.pdf", Bytes.pdf())
            val foreign = uploaded(owner, other, "c.png", Bytes.png())

            val result = owner.http().get().uri("/api/boards/{id}/files/urls?ids={ids}", board.id, "${b.id},${foreign.id},${a.id}")
                .exchange().expectBody<FileUrlList>().returnResult()

            assertEquals(listOf(b.id, a.id), result.responseBody?.items?.map { it.fileId }, "order of the ids, the foreign one left out")
            assertEquals("no-store", result.responseHeaders.cacheControl, "signed URLs are not cached")
            val first = checkNotNull(result.responseBody?.items?.first())
            assertTrue(first.url.startsWith("/files/${b.id}?v=original&exp="), "format of the contract: ${first.url}")
            assertNull(first.thumbnailUrl, "a pdf has no thumbnail")
        }

        @Test
        fun `when ids are malformed then 400`() {
            val owner = user("Olga")
            val board = owner.createBoard()

            val result = owner.http().get().uri(
                "/api/boards/{id}/files/urls?ids=not-a-uuid",
                board.id,
            ).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "pattern of the contract")
        }
    }

    @Nested
    inner class Removing {

        @Test
        fun `when a file is deleted then 204, the bytes are gone and the file is 404`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val file = uploaded(owner, board, "a.png", Bytes.png())

            val deleted = owner.http().delete().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<String>().returnResult()
            val again = owner.http().get().uri(
                "/api/boards/{b}/files/{f}",
                board.id,
                file.id,
            ).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NO_CONTENT, deleted.status, "deleted")
            assertEquals(ErrorCode.FILES_FILE_NOT_FOUND, again.responseBody?.code, "gone")
            assertEquals(emptyList(), storedBlobs(root, file.id), "the blobs are removed")
        }

        @Test
        fun `when a board is purged for good then its files and their bytes are removed with it`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            val keep = owner.createBoard()
            val file = uploaded(owner, board, "a.png", Bytes.png())
            val kept = uploaded(owner, keep, "b.png", Bytes.png())
            assertTrue(storedBlobs(root, file.id).isNotEmpty(), "stored before")

            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/boards/${board.id}"), "to the trash")
            assertTrue(storedBlobs(root, file.id).isNotEmpty(), "files follow the board into the trash: still there (S4.13)")
            assertEquals(HttpStatus.NO_CONTENT, owner.status("DELETE", "/api/trash/boards/${board.id}"), "purged for good")

            assertEquals(emptyList(), storedBlobs(root, file.id), "the bytes are gone with the board")
            assertTrue(storedBlobs(root, kept.id).isNotEmpty(), "the other board's file stays")
            assertEquals(HttpStatus.NOT_FOUND, owner.status("GET", "/api/boards/${board.id}/files"), "board gone")
        }

        @Test
        fun `when a board is in the trash then its files answer 404 LIBRARY_BOARD_NOT_FOUND`() {
            val owner = user("Olga")
            val board = owner.createBoard()
            uploaded(owner, board, "a.png", Bytes.png())
            owner.status("DELETE", "/api/boards/${board.id}")

            val result = owner.http().get().uri("/api/boards/{id}/files", board.id).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(
                ErrorCode.LIBRARY_BOARD_NOT_FOUND,
                result.responseBody?.code,
                "a board in the trash does not exist for its files either",
            )
        }
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
