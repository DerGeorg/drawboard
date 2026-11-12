package at.dergeorg.drawboard.files.domain.files.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the file events (S7.1). Never a URL signature or a token.
// Rules: the logical name never changes; a new field needs a default; a change of meaning gets a new name (.v2).

/** A file was uploaded: what it is and who did it is in the event itself. */
@AuditDetails(type = "files.file-uploaded")
data class FileUploaded(
    val boardId: String,
    val name: String,
    val mediaType: String,
    val kind: String,
    val size: Long,
    val sha256: String,
) : DomainEventDetails

/** A file was deleted by hand ([withBoard] false) or with its board's purge ([withBoard] true). */
@AuditDetails(type = "files.file-deleted")
data class FileDeleted(
    val boardId: String,
    val name: String,
    val kind: String,
    val size: Long,
    val withBoard: Boolean = false,
) : DomainEventDetails

/** The PDF conversion of a document ended: [result] is `DONE` or `FAILED` ([reason] is a short code, never a message). */
@AuditDetails(type = "files.file-converted")
data class FileConverted(
    val boardId: String,
    val result: String,
    val reason: String? = null,
    val pdfSize: Long? = null,
    val pages: Int? = null,
) : DomainEventDetails

/**
 * An upload was refused after the scan found something (S4.12). No file exists, so the event is about the file id that was made for
 * it. [signature] is the scanner's name for the finding (printable, cut), [sha256] is of the bytes.
 */
@AuditDetails(type = "files.file-rejected")
data class FileRejected(
    val boardId: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val reason: String,
    val signature: String? = null,
) : DomainEventDetails
