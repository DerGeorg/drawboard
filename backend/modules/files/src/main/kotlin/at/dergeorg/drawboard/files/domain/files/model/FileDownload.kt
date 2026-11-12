package at.dergeorg.drawboard.files.domain.files.model

import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import java.nio.channels.SeekableByteChannel

/** One byte range of a variant, both ends inclusive and inside the file (S4.7). */
data class ByteRange(val first: Long, val last: Long) {
    val length: Long get() = last - first + 1
}

/**
 * A variant of a file that was authorised by a valid signature and is ready to be served. [range] is the one validated
 * byte range the client asked for (null = the whole file); [open] opens the stored bytes (the caller closes the channel).
 * [inline] is true for images and videos, everything else is served as an attachment (S4.5).
 */
class FileDownload(
    val fileName: String,
    val mediaType: String,
    val inline: Boolean,
    val size: Long,
    val range: ByteRange?,
    val open: () -> SeekableByteChannel,
)

/** The `Range` header cannot be served: more than one range, malformed, or outside the file (416). [size] goes into `Content-Range`. */
class RangeNotSatisfiableException(val size: Long) : DomainException(ErrorCode.FILES_RANGE_NOT_SATISFIABLE)
