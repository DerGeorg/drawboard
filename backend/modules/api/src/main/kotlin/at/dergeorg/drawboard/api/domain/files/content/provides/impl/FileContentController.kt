package at.dergeorg.drawboard.api.domain.files.content.provides.impl

import at.dergeorg.drawboard.api.domain.files.content.provides.FileContentApiUseCase
import at.dergeorg.drawboard.contract.api.FileContentApi
import at.dergeorg.drawboard.files.domain.files.model.FileDownload
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.AbstractResource
import org.springframework.core.io.Resource
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.io.InputStream
import java.nio.channels.Channels
import java.nio.channels.ReadableByteChannel
import java.nio.charset.StandardCharsets
import kotlin.uuid.Uuid

/**
 * Serves the bytes of a file variant on `/files/{fileId}` - OUTSIDE `/api`, which is why the type-level mapping is empty:
 * it replaces the `/api` prefix the generated [FileContentApi] carries (the generators ignore the contract's
 * operation-level `servers`). The route is `permitAll` for GET in the route table; the signature in the query decides.
 *
 * The headers are those of S4.5 and are set on every successful answer; Spring Security does not add its own
 * `Cache-Control` to a response that has one. The ONE byte range is validated by the files module (a bad `Range` is a 416
 * before this point) and cut by Spring's resource writer, which answers 206 with `Content-Range` and the length of the part.
 */
@RestController
@RequestMapping("")
internal class FileContentController(
    private val content: FileContentApiUseCase,
    /** `DRAWBOARD_FILES_ORIGIN`: files on an origin of their own are same-site, not same-origin (S4.6). */
    @Value("\${files.files-origin:}") private val filesOrigin: String,
) : FileContentApi {

    @WithSpan
    override suspend fun downloadFile(
        v: String,
        exp: Long,
        sig: String,
        @SpanAttribute("file.id") fileId: Uuid,
        range: String?,
    ): ResponseEntity<Resource> {
        val download = content.open(fileId, v, exp, sig, range)
        val disposition = ContentDisposition.builder(if (download.inline) "inline" else "attachment")
            .filename(download.fileName, StandardCharsets.UTF_8)
            .build()
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(download.mediaType))
            .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", "default-src 'none'; sandbox")
            .header("Cross-Origin-Resource-Policy", if (filesOrigin.isBlank()) "same-origin" else "same-site")
            .header(HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
            .body(StoredBytes(download))
    }

    /** The stored bytes as a Spring resource: Spring reads the channel off the event loop and cuts the range. */
    private class StoredBytes(private val download: FileDownload) : AbstractResource() {
        override fun getDescription(): String = "stored file"

        override fun contentLength(): Long = download.size

        override fun lastModified(): Long = 0

        override fun getInputStream(): InputStream = Channels.newInputStream(download.open())

        override fun readableChannel(): ReadableByteChannel = download.open()

        override fun isReadable(): Boolean = true

        override fun exists(): Boolean = true
    }
}
