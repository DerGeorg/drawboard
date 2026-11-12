package at.dergeorg.drawboard.api.domain.collab

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.domain.collab.sessions.provides.CollabApiUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.RestoreVersionCommand
import at.dergeorg.drawboard.collab.domain.rooms.provides.StoreSnapshotCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.TicketsUseCase
import at.dergeorg.drawboard.contract.model.BoardVersion
import at.dergeorg.drawboard.contract.model.BoardVersionList
import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.io.buffer.DataBufferLimitException
import org.springframework.core.io.buffer.DataBufferUtils
import org.springframework.http.codec.multipart.Part
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the API use cases of the collab module. The ticket needs a role on the board (library) and the expiry of
 * the caller's token; the snapshot upload needs the role EDITOR or OWNER. collab itself knows neither library nor the
 * token - this service is where the two meet.
 */
@Service
internal class CollabApiService(
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val tickets: TicketsUseCase,
    private val collab: CollabUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
    @Value("\${collab.max-snapshot-bytes:52428800}") private val maxSnapshotBytes: Long,
) : CollabApiUseCase {

    @WithSpan
    override suspend fun createTicket(@SpanAttribute("board.id") boardId: Uuid): CollabTicket {
        val command = callers.guestOrNull()?.let { guestTicket(it, boardId) } ?: userTicket(boardId)
        val issued = tickets.issue(command)
        return CollabTicket(
            ticket = issued.ticket,
            expiresAt = issued.expiresAt,
            url = "$basePath/boards/$boardId/collab",
            protocol = PROTOCOL,
        )
    }

    private suspend fun userTicket(boardId: Uuid): IssueTicketCommand {
        val profile = signedIn.profile()
        // 404 LIBRARY_BOARD_NOT_FOUND for a board the user has no role on - even a viewer may open it
        val caller = signedIn.caller()
        boards.getBoard(caller, boardId)
        return IssueTicketCommand(
            userId = profile.id,
            boardId = boardId,
            displayName = profile.displayName ?: profile.username,
            tokenExpiresAt = signedIn.tokenExpiresAt() ?: throw DomainException(ErrorCode.UNAUTHORIZED),
            groups = caller.groups,
        )
    }

    /** A guest's ticket (S1.7, S1.10): bound to the guest session and its link, the session ends with the guest token. */
    private suspend fun guestTicket(guest: CurrentGuest, boardId: Uuid): IssueTicketCommand {
        // the link is checked again; a board outside the guest's share is "not found"
        boards.getBoard(callers.any(), boardId)
        return IssueTicketCommand(
            userId = guest.id,
            boardId = boardId,
            displayName = guest.name,
            tokenExpiresAt = guest.tokenExpiresAt,
            shareId = guest.shareId,
        )
    }

    @WithSpan
    override suspend fun uploadSnapshot(@SpanAttribute("board.id") boardId: Uuid, upToSeq: Long, snapshot: Part) {
        val caller = signedIn.caller()
        val userId = caller.id
        val role = boards.roleOf(caller, boardId)
            ?: throw DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))
        if (role != BoardRole.OWNER && role != BoardRole.EDITOR) {
            throw DomainException(
                ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to boardId.toString(), "required" to "EDITOR or OWNER"),
            )
        }
        // Before the body: 429 / 409 cost nothing. Only then up to 50 MB are read; storeSnapshot consumes the request.
        collab.checkSnapshotUpload(userId, boardId, upToSeq)
        collab.storeSnapshot(StoreSnapshotCommand(userId, boardId, upToSeq, readLimited(snapshot)))
    }

    @WithSpan
    override suspend fun listVersions(@SpanAttribute("board.id") boardId: Uuid): BoardVersionList {
        requireOwner(boardId)
        return BoardVersionList(
            items = collab.listVersions(boardId).map {
                BoardVersion(id = it.id, upToSeq = it.upToSeq, createdAt = it.createdAt, size = it.size)
            },
        )
    }

    @WithSpan
    override suspend fun restoreVersion(@SpanAttribute("board.id") boardId: Uuid, versionId: Uuid) {
        val owner = requireOwner(boardId)
        // An unknown version must not throw anybody out of the board.
        if (collab.listVersions(boardId).none { it.id == versionId }) {
            throw DomainException(
                ErrorCode.COLLAB_VERSION_NOT_FOUND,
                mapOf("boardId" to boardId.toString(), "versionId" to versionId.toString()),
            )
        }
        // Sessions end FIRST (4410) and joins wait: an update arriving during the restore would land on the emptied log.
        // When the restore is committed, clients reconnect and read the restored state (docs/collab-protocol.md).
        collab.beginReplace(boardId)
        try {
            collab.restoreVersion(RestoreVersionCommand(userId = owner, boardId = boardId, versionId = versionId))
        } finally {
            collab.endReplace(boardId)
        }
    }

    /** The caller must own the board: "not found" without a role, `LIBRARY_BOARD_ACCESS_DENIED` with a weaker one. */
    private suspend fun requireOwner(boardId: Uuid): Uuid {
        val caller = signedIn.caller()
        val role = boards.roleOf(caller, boardId)
            ?: throw DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))
        if (role != BoardRole.OWNER) {
            throw DomainException(
                ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to boardId.toString(), "required" to "OWNER"),
            )
        }
        return caller.id
    }

    /** The bytes of [part]; more than [maxSnapshotBytes] stops the read at once (413), nothing beyond is buffered. */
    private suspend fun readLimited(part: Part): ByteArray {
        val buffer = try {
            DataBufferUtils.join(part.content(), maxSnapshotBytes.toInt()).awaitSingleOrNull()
        } catch (_: DataBufferLimitException) {
            throw PayloadTooLargeException(maxSnapshotBytes)
        } ?: return ByteArray(0)
        try {
            return ByteArray(buffer.readableByteCount()).also(buffer::read)
        } finally {
            DataBufferUtils.release(buffer)
        }
    }

    private companion object {
        const val PROTOCOL = "drawboard.v1"
    }
}
