package at.dergeorg.drawboard.api.domain.collab.sessions.provides

import at.dergeorg.drawboard.contract.model.BoardVersionList
import at.dergeorg.drawboard.contract.model.CollabTicket
import org.springframework.http.codec.multipart.Part
import kotlin.uuid.Uuid

/** The collaboration part of the REST API in contract types. The controller does HTTP, this does the translation. */
interface CollabApiUseCase {

    suspend fun createTicket(boardId: Uuid): CollabTicket

    /** [snapshot] is the multipart part of the upload; it is read with a hard size limit. */
    suspend fun uploadSnapshot(boardId: Uuid, upToSeq: Long, snapshot: Part)

    /** The kept versions of the board, newest first. Owner only. */
    suspend fun listVersions(boardId: Uuid): BoardVersionList

    /** Replaces the drawing by the version and closes all sessions with 4410. Owner only. */
    suspend fun restoreVersion(boardId: Uuid, versionId: Uuid)
}
