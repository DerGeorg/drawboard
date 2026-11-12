package at.dergeorg.drawboard.library.domain.access

import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import kotlin.uuid.Uuid

/** The failures every library use case reports the same way - one place, so a message and a status exist once. */
internal object LibraryErrors {

    fun boardNotFound(id: Uuid) = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to id.toString()))

    fun folderNotFound(id: Uuid) = DomainException(ErrorCode.LIBRARY_FOLDER_NOT_FOUND, mapOf("folderId" to id.toString()))

    fun conflict(kind: String, id: Uuid, currentVersion: Long) =
        DomainException(ErrorCode.CONFLICT, mapOf("${kind}Id" to id.toString(), "currentVersion" to currentVersion.toString()))

    /** The contract only guarantees 1..[max] characters; a text of blanks passes that and is rejected here. */
    fun validText(field: String, submitted: String, max: Int): String {
        val text = submitted.trim()
        if (text.isEmpty()) throw invalid(field, "NotBlank", "must not be blank")
        if (text.length > max) throw invalid(field, "Size", "size must be between 1 and $max")
        return text
    }

    private fun invalid(field: String, constraint: String, message: String) =
        ValidationFailedException(listOf(InvalidField(field = field, constraint = constraint, message = message)))
}
