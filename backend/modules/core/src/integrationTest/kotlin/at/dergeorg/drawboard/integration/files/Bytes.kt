package at.dergeorg.drawboard.integration.files

import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.integration.collab.SharingUser
import org.springframework.http.HttpHeaders
import org.springframework.test.web.reactive.server.EntityExchangeResult
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import javax.imageio.ImageIO
import kotlin.uuid.Uuid

/** Bytes of real files for the upload tests. */
object Bytes {

    fun png(width: Int = 8, height: Int = 6): ByteArray = image("png", width, height)

    fun jpeg(width: Int = 8, height: Int = 6): ByteArray = image("jpg", width, height)

    private fun image(format: String, width: Int, height: Int): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        for (x in 0 until width) for (y in 0 until height) image.setRGB(x, y, (x * 30 shl 16) or (y * 40 shl 8) or 0x70)
        return ByteArrayOutputStream().also { ImageIO.write(image, format, it) }.toByteArray()
    }

    /** A JPEG whose header carries an EXIF block with a location, an XMP block and a comment (all must be removed). */
    fun jpegWithExif(width: Int, height: Int): ByteArray {
        val plain = jpeg(width, height)
        fun segment(marker: Int, payload: ByteArray) =
            byteArrayOf(0xFF.toByte(), marker.toByte(), ((payload.size + 2) shr 8).toByte(), (payload.size + 2).toByte()) + payload
        val exifHeader = "Exif\u0000\u0000".toByteArray(Charsets.ISO_8859_1)
        val exif = exifHeader + byteArrayOf('M'.code.toByte(), 'M'.code.toByte(), 0, 42, 0, 0, 0, 8) +
            byteArrayOf(0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0) + "GPS: 48.2082N 16.3738E".toByteArray()
        return plain.copyOf(2) + segment(0xE1, exif) + segment(0xE1, "http://ns.adobe.com/xap/1.0/\u0000<x:xmpmeta/>".toByteArray()) +
            segment(0xFE, "someone".toByteArray()) + plain.copyOfRange(2, plain.size)
    }

    fun pdf(): ByteArray = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n".toByteArray()

    /** A ZIP with the entries of an Office Open XML word processing file (the server only looks at the names). */
    fun docx(): ByteArray {
        val out = ByteArrayOutputStream()
        java.util.zip.ZipOutputStream(out).use { zip ->
            listOf("[Content_Types].xml", "_rels/.rels", "word/document.xml").forEach {
                zip.putNextEntry(java.util.zip.ZipEntry(it))
                zip.write("<x/>".toByteArray())
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    fun svg(): ByteArray = """<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>""".toByteArray()

    fun exe(): ByteArray = byteArrayOf('M'.code.toByte(), 'Z'.code.toByte(), 0x90.toByte(), 0, 3, 0, 0, 0, 4, 0, 0, 0) + ByteArray(64)
}

/** A multipart upload to `POST /api/boards/{id}/files`; returns the raw exchange so the test checks the status itself. */
fun WebTestClient.uploadAs(token: String, boardId: Uuid, fileName: String, bytes: ByteArray): EntityExchangeResult<String> =
    mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer $token").build()
        .post().uri("/api/boards/{id}/files", boardId)
        .multipartForm("file", bytes, fileName)
        .exchange().expectBody<String>().returnResult()

/** Every file below [root] whose name starts with [fileId]: the blobs (original and variants) stored for a file. */
fun storedBlobs(root: Path, fileId: Uuid): List<Path> {
    if (!Files.exists(root)) return emptyList()
    return Files.walk(root).use { paths -> paths.filter { it.fileName.toString().startsWith(fileId.toString()) }.toList() }
}

fun SharingUser.upload(client: WebTestClient, boardId: Uuid, fileName: String, bytes: ByteArray): EntityExchangeResult<String> =
    client.uploadAs(token, boardId, fileName, bytes)
