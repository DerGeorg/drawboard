package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.api.domain.planning.sessions.provides.EstimationAnswer
import at.dergeorg.drawboard.api.domain.planning.sessions.provides.EstimationApiUseCase
import at.dergeorg.drawboard.contract.model.EstimationAdvance
import at.dergeorg.drawboard.contract.model.EstimationDecision
import at.dergeorg.drawboard.contract.model.EstimationEntry
import at.dergeorg.drawboard.contract.model.EstimationPlacement
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionList
import at.dergeorg.drawboard.contract.model.EstimationStart
import at.dergeorg.drawboard.contract.model.NewEstimationSession
import at.dergeorg.drawboard.contract.model.RotationEstimate
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import at.dergeorg.drawboard.planning.domain.sessions.provides.AdvanceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.DecideCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimateCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationPlayUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.GetSessionQuery
import at.dergeorg.drawboard.planning.domain.sessions.provides.PlaceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionAnswer
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionOperation
import at.dergeorg.drawboard.planning.domain.sessions.provides.StartCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the estimation part of the API (3.15, Fable E1-E24, C1-C3): who may do what comes from the role on the board, and a guest
 * only from the role of its link. The planning module trusts this check; it knows no token, role or board.
 *
 * Order of refusals, the same for every operation (C2): board role (404 `LIBRARY_BOARD_NOT_FOUND`, also in the trash) -> VIEWER-link
 * guest (403 `FORBIDDEN`) -> session, E9 and card ([EstimationUseCase.header], 404) -> role (403 `LIBRARY_BOARD_ACCESS_DENIED`) ->
 * what the planning module checks from there (seat, state, card held, value, reason, limits).
 *
 * * list, get: every role; join, leave, placement, estimate: COMMENTER or higher; create: EDITOR or OWNER, signed in; start, advance,
 *   decide, finish, cancel: the moderator (E13) - the creator while still EDITOR or OWNER, or the board's OWNER.
 * * Guests (E8): only with a COMMENTER or EDITOR link; list (ACTIVE only), get, join, leave, placement, estimate. Never a moderator
 *   operation (the route table already says 403). A guest never sees a member's user id.
 */
@Service
@Suppress("TooManyFunctions")
internal class EstimationApiService(
    private val access: PlanningAccess,
    private val estimation: EstimationUseCase,
    private val play: EstimationPlayUseCase,
) : EstimationApiUseCase {

    @WithSpan
    override suspend fun listSessions(@SpanAttribute("board.id") boardId: Uuid, state: String): EstimationSessionList {
        val closed = state == CLOSED // the contract's pattern lets only ACTIVE and CLOSED through
        val seen = access.access(boardId)
        if (seen.guest != null && closed) throw DomainException(ErrorCode.FORBIDDEN)
        val found = estimation.list(boardId, if (closed) SessionState.CLOSED else SessionState.ACTIVE, viewerOf(seen))
        val names = access.namesOf(found.map { it.moderatorId })
        return EstimationSessionList(items = found.map { EstimationMappings.summary(it, names) })
    }

    @WithSpan
    override suspend fun createSession(@SpanAttribute("board.id") boardId: Uuid, request: NewEstimationSession): EstimationSession {
        val member = access.requireMember(boardId, "EDITOR or OWNER") { it == BoardRole.OWNER || it == BoardRole.EDITOR }
        return contract(estimation.create(EstimationMappings.command(boardId, member.principal, request)), guest = false)
    }

    @WithSpan
    override suspend fun getSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        ifNoneMatch: String?,
    ): EstimationAnswer {
        val seen = access.access(boardId)
        return when (val answer = estimation.get(GetSessionQuery(boardId, sessionId, viewerOf(seen)) { access.matches(ifNoneMatch, it) })) {
            is SessionAnswer.NotModified -> EstimationAnswer.NotModified(answer.version)
            is SessionAnswer.Found -> EstimationAnswer.Found(contract(answer.session, guest = seen.guest != null))
        }
    }

    @WithSpan
    override suspend fun joinSession(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("session.id") sessionId: Uuid) {
        val seen = takingPart(boardId, sessionId, SessionOperation.JOIN_OR_LEAVE, itemId = null)
        estimation.join(boardId, sessionId, seen.principal)
    }

    @WithSpan
    override suspend fun leaveSession(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("session.id") sessionId: Uuid) {
        val seen = takingPart(boardId, sessionId, SessionOperation.JOIN_OR_LEAVE, itemId = null)
        estimation.leave(boardId, sessionId, seen.principal)
    }

    @WithSpan
    override suspend fun startSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        request: EstimationStart,
    ): EstimationSession {
        val viewer = moderator(boardId, sessionId, itemId = null).viewer
        return contract(estimation.start(StartCommand(boardId, sessionId, viewer, request.seatIds)), guest = false)
    }

    @WithSpan
    override suspend fun advanceSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        request: EstimationAdvance,
    ): EstimationSession {
        val viewer = moderator(boardId, sessionId, itemId = null).viewer
        val command = AdvanceCommand(boardId, sessionId, viewer, EstimationMappings.state(request.state), request.round)
        return contract(estimation.advance(command), guest = false)
    }

    @WithSpan
    override suspend fun finishSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): EstimationSession {
        val viewer = moderator(boardId, sessionId, itemId = null).viewer
        return contract(estimation.finish(boardId, sessionId, viewer), guest = false)
    }

    @WithSpan
    override suspend fun cancelSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): EstimationSession {
        val viewer = moderator(boardId, sessionId, itemId = null).viewer
        return contract(estimation.cancel(boardId, sessionId, viewer), guest = false)
    }

    @WithSpan
    override suspend fun placeItem(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        itemId: Uuid, // no span attribute: with a guest's request it would tie the card to a seat (B1)
        request: EstimationPlacement,
    ) {
        val seen = takingPart(boardId, sessionId, SessionOperation.PLACE, itemId)
        val state = request.state?.let { EstimationMappings.state(it) }
        play.place(PlaceCommand(boardId, sessionId, itemId, seen.principal, request.`value`, state))
    }

    @WithSpan
    override suspend fun setEstimate(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        itemId: Uuid, // no span attribute: with a guest's request it would tie the card to a seat (B1)
        request: RotationEstimate,
    ): EstimationEntry {
        val seen = takingPart(boardId, sessionId, SessionOperation.ESTIMATE, itemId)
        val command = EstimateCommand(boardId, sessionId, itemId, seen.principal, request.`value`, request.reason, request.round)
        val entry = play.estimate(command)
        return EstimationMappings.entry(entry)
    }

    @WithSpan
    override suspend fun decideItem(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        @SpanAttribute("item.id") itemId: Uuid,
        request: EstimationDecision,
    ) {
        val moderator = moderator(boardId, sessionId, itemId)
        play.decide(DecideCommand(boardId, sessionId, itemId, moderator.member, request.`value`))
    }

    /**
     * Join, leave, placement, estimate: board (404), guest link (403), the rate of [operation], session/E9/card (404), then a member needs
     * COMMENTER (403).
     */
    private suspend fun takingPart(
        boardId: Uuid,
        sessionId: Uuid,
        operation: SessionOperation,
        itemId: Uuid?,
    ): PlanningAccess.Access {
        val seen = access.access(boardId)
        estimation.header(boardId, sessionId, seen.principal, operation, itemId)
        if (seen.guest == null && seen.role == BoardRole.VIEWER) throw access.accessDenied(boardId, "COMMENTER or higher")
        return seen
    }

    /** Start, advance, decide, finish, cancel: never a guest; board (404), session and card (404), then the moderator (403, E13). */
    private suspend fun moderator(boardId: Uuid, sessionId: Uuid, itemId: Uuid?): Moderator {
        access.denyGuest()
        val member = access.requireMember(boardId, "the moderator or OWNER") { true }
        val header = estimation.header(boardId, sessionId, member.principal, SessionOperation.MODERATE, itemId)
        val viewer = Viewer(
            principal = member.principal,
            editor = member.role == BoardRole.OWNER || member.role == BoardRole.EDITOR,
            owner = member.role == BoardRole.OWNER,
        )
        if (!viewer.moderates(header.moderatorId)) throw access.accessDenied(boardId, "the moderator or OWNER")
        return Moderator(viewer, member.principal)
    }

    /** A caller who moderates the session: as a viewer of the answers, and as the member who decides. */
    private class Moderator(val viewer: Viewer, val member: Principal.Member)

    private fun viewerOf(seen: PlanningAccess.Access): Viewer = Viewer(
        principal = seen.principal,
        editor = seen.guest == null && (seen.role == BoardRole.OWNER || seen.role == BoardRole.EDITOR),
        owner = seen.guest == null && seen.role == BoardRole.OWNER,
    )

    private suspend fun contract(view: SessionView, guest: Boolean): EstimationSession =
        EstimationMappings.session(view, guest, access.namesOf(EstimationMappings.userIds(view)))

    private companion object {
        const val CLOSED = "CLOSED"
    }
}
