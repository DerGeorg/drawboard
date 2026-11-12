package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.BoardFile
import at.dergeorg.drawboard.contract.model.FileUrlList
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.integration.CapturedSpans
import at.dergeorg.drawboard.integration.IntegrationTest
import at.dergeorg.drawboard.integration.signedInAs
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** S7.2: a signed file URL is a secret; its query string must not end up in a span (or a metric tag) - they go to Tempo and Grafana. */
@IntegrationTest
class FileUrlLeakIntegrationTest(private val client: WebTestClient, private val spans: CapturedSpans) {

    @Test
    fun `when a file is fetched through its signed url then no span carries the query string or the signature`() {
        val http = client.signedInAs(ALICE)
        val board = checkNotNull(
            http.post().uri("/api/boards").bodyValue(NewBoard("Leaks")).exchange().expectBody<Board>().returnResult().responseBody,
        )
        val file = http.post().uri("/api/boards/{id}/files", board.id).multipartForm("file", Bytes.png(), "a.png")
            .exchange().expectBody<BoardFile>().returnResult().responseBody
        val url = checkNotNull(
            http.get().uri("/api/boards/{id}/files/urls?ids={f}", board.id, checkNotNull(file).id).exchange()
                .expectBody<FileUrlList>().returnResult().responseBody?.items?.single()?.url,
        )
        val signature = url.substringAfter("sig=")
        spans.clear()

        val result = client.get().uri(url).exchange().expectBody<ByteArray>().returnResult()

        assertEquals(HttpStatus.OK, result.status, "the file is served")
        val values = spans.finished.flatMap { span -> span.attributes.asMap().values.map { it.toString() } }
        assertTrue(values.isNotEmpty(), "spans were recorded")
        assertTrue(
            values.none { signature in it || "exp=" in it || "?v=" in it },
            "no span attribute holds the query string: ${values.filter { "/files/" in it }}",
        )
        assertTrue(values.any { it == "/files/{fileId}" || it.endsWith("/files/${file.id}") }, "the path (template) is still there")
    }
}
