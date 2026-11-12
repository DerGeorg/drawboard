package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.requires.ConversionFailedException
import at.dergeorg.drawboard.files.domain.files.requires.Converter
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.reactive.asFlow
import kotlinx.coroutines.reactor.asFlux
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.core.io.buffer.DataBuffer
import org.springframework.core.io.buffer.DataBufferUtils
import org.springframework.core.io.buffer.DefaultDataBufferFactory
import org.springframework.http.MediaType
import org.springframework.http.client.MultipartBodyBuilder
import org.springframework.stereotype.Component
import org.springframework.web.reactive.function.BodyInserters
import org.springframework.web.reactive.function.client.WebClient

/**
 * The Gotenberg adapter (S4.10): LibreOffice in a sidecar that only this backend can reach (an `internal` network, no
 * route to the outside). The ONLY endpoint used is `POST /forms/libreoffice/convert`; the bytes go in as the multipart
 * field `files`, named after the DETECTED type (Gotenberg picks the import filter from the extension), and the PDF
 * comes back as the body. No user-controlled string reaches the request: not the name, not the URL. Error bodies of the
 * sidecar are never read into a message (they may quote the document).
 */
@Component
@ConditionalOnExpression("'\${files.gotenberg-url:}'.trim() != ''")
internal class GotenbergConverter(@Value("\${files.gotenberg-url}") baseUrl: String) : Converter {

    private val client: WebClient = WebClient.builder().baseUrl(baseUrl.trimEnd('/')).build()

    override fun toPdf(extension: String, source: Flow<ByteArray>): Flow<ByteArray> = flow {
        val factory = DefaultDataBufferFactory.sharedInstance
        val parts = MultipartBodyBuilder()
        parts.asyncPart("files", source.asFlux().map { factory.wrap(it) }, DataBuffer::class.java)
            .filename("document.$extension")
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
        val response = client.post().uri(PATH)
            .accept(MediaType.APPLICATION_PDF)
            .body(BodyInserters.fromMultipartData(parts.build()))
            .retrieve()
            .onStatus(
                { it.isError },
            ) { reactor.core.publisher.Mono.error(ConversionFailedException("CONVERTER_HTTP_${it.statusCode().value()}")) }
            .bodyToFlux(DataBuffer::class.java)
            .map { buffer ->
                try {
                    ByteArray(buffer.readableByteCount()).also(buffer::read)
                } finally {
                    DataBufferUtils.release(buffer)
                }
            }
        response.asFlow().collect { emit(it) }
    }

    private companion object {
        const val PATH = "/forms/libreoffice/convert"
    }
}

/** The converter of a deployment without Gotenberg: every conversion fails with a code (the original stays downloadable). */
@Component
@ConditionalOnExpression("'\${files.gotenberg-url:}'.trim() == ''")
internal class NoConverter : Converter {
    override fun toPdf(extension: String, source: Flow<ByteArray>): Flow<ByteArray> = throw ConversionFailedException("NO_CONVERTER")
}
