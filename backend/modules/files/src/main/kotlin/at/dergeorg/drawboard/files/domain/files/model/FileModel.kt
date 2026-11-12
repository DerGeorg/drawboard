package at.dergeorg.drawboard.files.domain.files.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** What a file is, from its detected media type. Same names as `BoardFileKind` of the API contract. */
enum class FileKind { IMAGE, VIDEO, PDF, DOCUMENT }

/** State of the PDF conversion of a DOCUMENT (S4.10). Same names as `BoardFileConversion` of the API contract. */
enum class Conversion { NONE, PENDING, DONE, FAILED }

/** The variants of a file that can be served; [wire] is the value of `v` in the signed URL. */
enum class FileVariant(val wire: String) {
    ORIGINAL("original"),
    THUMBNAIL("thumbnail"),
    PDF("pdf"),
    ;

    companion object {
        fun ofWire(value: String): FileVariant? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The metadata of a file. Every file belongs to exactly one board. [name] is sanitised; the bytes are stored under
 * [id], never under the name. [createdBy] is the uploader (guests cannot upload); the API leaves it out for guests.
 */
data class StoredFile(
    val id: Uuid,
    val boardId: Uuid,
    val name: String,
    val mediaType: String,
    val kind: FileKind,
    val size: Long,
    val createdAt: Instant,
    val createdBy: Uuid,
    val conversion: Conversion = Conversion.NONE,
    val pageCount: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
    /** Media type of the thumbnail variant (`image/jpeg` or `image/png`); null = there is none. */
    val thumbnailMediaType: String? = null,
    /** Size of the converted PDF; null = there is none. */
    val pdfSize: Long? = null,
    /** Optimistic lock; null = not stored yet. */
    val version: Long? = null,
)

/** Signed URLs of one file (S4.4); relative to the origin of the app. Secrets: never logged, never stored in a board. */
data class SignedFileUrls(
    val fileId: Uuid,
    val url: String,
    val thumbnailUrl: String?,
    val pdfUrl: String?,
    val originalUrl: String,
)

/** The answer of [at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase.issueUrls]. */
data class IssuedUrls(val expiresAt: Instant, val items: List<SignedFileUrls>)
