package at.dergeorg.drawboard.api.domain.collab.sessions.provides.impl

import at.dergeorg.drawboard.api.domain.collab.sessions.provides.CollabApiUseCase
import at.dergeorg.drawboard.contract.api.CollabApi
import at.dergeorg.drawboard.contract.model.BoardVersionList
import at.dergeorg.drawboard.contract.model.CollabTicket
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.http.ResponseEntity
import org.springframework.http.codec.multipart.Part
import org.springframework.web.bind.annotation.RestController
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [CollabApi] (ticket for the WebSocket, snapshot upload) and delegates to
 * [CollabApiUseCase]. The WebSocket itself is not part of the OpenAPI contract: see `CollabWebSocketConfiguration` and
 * docs/collab-protocol.md of the API repository.
 */
@RestController
internal class CollabController(private val collab: CollabApiUseCase) : CollabApi {

    @WithSpan
    override suspend fun createCollabTicket(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<CollabTicket> =
        ResponseEntity.ok(collab.createTicket(boardId))

    @WithSpan
    override suspend fun uploadBoardSnapshot(
        upToSeq: Long,
        @SpanAttribute("board.id") boardId: Uuid,
        snapshot: Part,
    ): ResponseEntity<Unit> {
        collab.uploadSnapshot(boardId, upToSeq, snapshot)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun listBoardVersions(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<BoardVersionList> =
        ResponseEntity.ok(collab.listVersions(boardId))

    @WithSpan
    override suspend fun restoreBoardVersion(@SpanAttribute("board.id") boardId: Uuid, versionId: Uuid): ResponseEntity<Unit> {
        collab.restoreVersion(boardId, versionId)
        return ResponseEntity.noContent().build()
    }
}
