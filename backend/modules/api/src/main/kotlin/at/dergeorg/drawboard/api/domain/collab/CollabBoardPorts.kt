package at.dergeorg.drawboard.api.domain.collab

import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardActivity
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Component
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The ports collab requires, implemented on top of library: collab and library never know each other, api is where
 * they are connected.
 */
@Component
internal class LibraryBoardAccess(private val boards: BoardsUseCase, private val links: LinksUseCase) : BoardAccess {

    @WithSpan
    override suspend fun roleOf(boardId: Uuid, who: Participant): CollabRole? = when (caller(who)?.let { boards.roleOf(it, boardId) }) {
        BoardRole.OWNER -> CollabRole.OWNER
        BoardRole.EDITOR -> CollabRole.EDITOR
        BoardRole.COMMENTER -> CollabRole.COMMENTER
        BoardRole.VIEWER -> CollabRole.VIEWER
        null -> null
    }

    /**
     * The group grants count with the groups of the token the ticket was issued with (S6.5). A guest is whatever their
     * link says NOW (S1.13): null once the link is revoked or expired, so the session loses its role (4403).
     */
    private suspend fun caller(who: Participant): Caller? =
        who.shareId?.let { links.guestCaller(it) } ?: Caller.User(who.userId, who.groups).takeIf { who.shareId == null }
}

/** The drawing changed: the board's `updatedAt` moves (not audited, no new version). */
@Component
internal class LibraryBoardActivity(private val boards: BoardsUseCase) : BoardActivity {

    @WithSpan
    override suspend fun contentChanged(boardId: Uuid, at: Instant) = boards.recordContentChange(boardId, at)
}
