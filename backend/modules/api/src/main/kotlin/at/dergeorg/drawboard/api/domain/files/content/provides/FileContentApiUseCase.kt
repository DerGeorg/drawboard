package at.dergeorg.drawboard.api.domain.files.content.provides

import at.dergeorg.drawboard.files.domain.files.model.FileDownload
import kotlin.uuid.Uuid

/** The delivery of file bytes through signed URLs (S4.4): no user, no token - the signature authorises. */
interface FileContentApiUseCase {

    /** Verifies the signature and opens the variant; `FILES_URL_INVALID`, `FILES_FILE_NOT_FOUND` or a 416 otherwise. */
    suspend fun open(fileId: Uuid, variant: String, exp: Long, signature: String, range: String?): FileDownload
}
