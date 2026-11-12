package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import kotlin.uuid.Uuid

/** The failures of the files use cases, one place for each message and status. */
internal object FilesErrors {

    fun notFound(fileId: Uuid) = DomainException(ErrorCode.FILES_FILE_NOT_FOUND, mapOf("fileId" to fileId.toString()))

    /** [mediaType] is what was detected; null when nothing was recognised (then no param - the code must not echo client input). */
    fun typeNotAllowed(mediaType: String?) =
        DomainException(ErrorCode.FILES_TYPE_NOT_ALLOWED, mediaType?.let { mapOf("mediaType" to it) } ?: emptyMap())

    fun quota(scope: String, limitBytes: Long) =
        DomainException(ErrorCode.FILES_QUOTA_EXCEEDED, mapOf("scope" to scope, "limit" to limitBytes.toString()))

    /** The ONE answer for every way a signed URL can be wrong (S4.4): the same body, so it does not say why. */
    fun urlInvalid() = DomainException(ErrorCode.FILES_URL_INVALID)

    fun tooManyPixels(maxPixels: Long) = ValidationFailedException(
        listOf(InvalidField("file", "MaxPixels", "an image may have at most ${maxPixels / MILLION} megapixels")),
    )

    /** A JPEG whose header segments cannot be walked to the start of the scan: refused, not guessed at (S4.8). */
    fun jpegUnreadable() = ValidationFailedException(
        listOf(InvalidField("file", "InvalidJpeg", "the JPEG header cannot be read up to the image data")),
    )

    /** The malware scan found something (S4.12): the contract has no code of its own, so it is the 415 of a file that is not allowed. */
    fun infected() = InfectedUploadException()

    private const val MILLION = 1_000_000L
}

/**
 * The upload is infected. Answered like [ErrorCode.FILES_TYPE_NOT_ALLOWED] (415) without any param - it must not tell the client
 * which signature matched. A class of its own so the metric can tell it from a type that is simply not on the allowlist.
 */
internal class InfectedUploadException : DomainException(ErrorCode.FILES_TYPE_NOT_ALLOWED)
