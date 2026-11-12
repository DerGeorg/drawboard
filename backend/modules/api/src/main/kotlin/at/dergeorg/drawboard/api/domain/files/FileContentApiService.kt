package at.dergeorg.drawboard.api.domain.files

import at.dergeorg.drawboard.api.domain.files.content.provides.FileContentApiUseCase
import at.dergeorg.drawboard.files.domain.files.model.FileDownload
import at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase
import at.dergeorg.drawboard.files.domain.files.provides.OpenFileCommand
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/** Implements the delivery of file bytes: nothing but the call into the files module - the signed URL is the whole authorisation. */
@Service
internal class FileContentApiService(private val files: FilesUseCase) : FileContentApiUseCase {

    @WithSpan
    override suspend fun open(
        @SpanAttribute("file.id") fileId: Uuid,
        variant: String,
        exp: Long,
        signature: String,
        range: String?,
    ): FileDownload = files.open(OpenFileCommand(fileId, variant, exp, signature, range))
}
