package at.dergeorg.drawboard.integration

import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient

/**
 * A multipart form with ONE part, written out as a whole so the request has a `Content-Length` - like a browser's `FormData`.
 * Spring's own multipart writer streams (chunked, no length), which the upload guard refuses with 411 (M3 backend review,
 * MUST 1). [filename] null makes the part a plain form field.
 */
fun WebTestClient.RequestBodySpec.multipartForm(
    name: String,
    bytes: ByteArray,
    filename: String? = "upload.bin",
): WebTestClient.RequestHeadersSpec<*> {
    val boundary = "drawboard-test-boundary"
    val disposition = "Content-Disposition: form-data; name=\"$name\"" + (filename?.let { "; filename=\"$it\"" } ?: "")
    val head = "--$boundary\r\n$disposition\r\nContent-Type: application/octet-stream\r\n\r\n".toByteArray()
    val tail = "\r\n--$boundary--\r\n".toByteArray()
    val body = head + bytes + tail
    return contentType(MediaType.parseMediaType("multipart/form-data; boundary=$boundary"))
        .contentLength(body.size.toLong())
        .bodyValue(body)
}
