package at.dergeorg.drawboard.api.domain.planning.sessions.provides

import at.dergeorg.drawboard.contract.model.EstimationAdvance
import at.dergeorg.drawboard.contract.model.EstimationDecision
import at.dergeorg.drawboard.contract.model.EstimationEntry
import at.dergeorg.drawboard.contract.model.EstimationPlacement
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionList
import at.dergeorg.drawboard.contract.model.EstimationStart
import at.dergeorg.drawboard.contract.model.NewEstimationSession
import at.dergeorg.drawboard.contract.model.RotationEstimate
import kotlin.uuid.Uuid

/** The estimation sessions of the API in contract types (3.15): the lobby, the phases, the inputs of the seats, the review. */
interface EstimationApiUseCase {

    suspend fun listSessions(boardId: Uuid, state: String): EstimationSessionList

    suspend fun createSession(boardId: Uuid, request: NewEstimationSession): EstimationSession

    /** The session, or [EstimationAnswer.NotModified] when [ifNoneMatch] names the current version. */
    suspend fun getSession(boardId: Uuid, sessionId: Uuid, ifNoneMatch: String?): EstimationAnswer

    suspend fun joinSession(boardId: Uuid, sessionId: Uuid)

    suspend fun leaveSession(boardId: Uuid, sessionId: Uuid)

    suspend fun startSession(boardId: Uuid, sessionId: Uuid, request: EstimationStart): EstimationSession

    suspend fun advanceSession(boardId: Uuid, sessionId: Uuid, request: EstimationAdvance): EstimationSession

    suspend fun finishSession(boardId: Uuid, sessionId: Uuid): EstimationSession

    suspend fun cancelSession(boardId: Uuid, sessionId: Uuid): EstimationSession

    suspend fun placeItem(boardId: Uuid, sessionId: Uuid, itemId: Uuid, request: EstimationPlacement)

    suspend fun setEstimate(boardId: Uuid, sessionId: Uuid, itemId: Uuid, request: RotationEstimate): EstimationEntry

    suspend fun decideItem(boardId: Uuid, sessionId: Uuid, itemId: Uuid, request: EstimationDecision)
}

/** The answer of getEstimationSession: 200 with the session, or 304 without a body - both carry the ETag `W/"<version>"`. */
sealed interface EstimationAnswer {
    val version: Long

    class Found(val session: EstimationSession) : EstimationAnswer {
        override val version: Long get() = session.version
    }

    class NotModified(override val version: Long) : EstimationAnswer
}
