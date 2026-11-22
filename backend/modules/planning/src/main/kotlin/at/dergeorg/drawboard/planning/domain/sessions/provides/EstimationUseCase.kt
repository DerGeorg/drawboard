package at.dergeorg.drawboard.planning.domain.sessions.provides

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionHeader
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSummary
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The life of an estimation session (3.15, Fable E1-E24): create, list, look, join and leave the lobby, start, advance, finish,
 * cancel - and what other modules need: revocation of guest links and the erasure of purged boards. Like the poker rounds it trusts
 * its caller (module `api`) with the token, the board role and that the board exists and is not in the trash; it never reads or
 * writes the Yjs document (E20).
 *
 * Order of refusals (C2): `api` answers the board role (404) and VIEWER-link guests (403), then asks [header] - the session, with the
 * guest rule E9 (404) and an unknown card (404) - and decides the role (403) itself; the operation then checks the seat (403), the
 * state and the expected round (409) and whatever follows for its mode. Every operation first applies what the server clock says
 * (E14, E15) and is rate limited per user and, for guests, per share link (E17).
 */
interface EstimationUseCase {

    /** Creates a session in LOBBY; [NewSessionCommand.moderator] becomes its moderator. Audited. */
    suspend fun create(command: NewSessionCommand): SessionView

    /** The sessions of a board in [states] (the active or the closed ones), newest first, as [viewer] sees them. Joins nobody. */
    suspend fun list(boardId: Uuid, states: Set<SessionState>, viewer: Viewer): List<SessionSummary>

    /** The session as [GetSessionQuery.viewer] sees it, or [SessionAnswer.NotModified] - compared after the clock and E9. */
    suspend fun get(query: GetSessionQuery): SessionAnswer

    /**
     * The moderator and the state of a session for the role decisions of `api`: 404 `PLANNING_SESSION_NOT_FOUND` for a session of
     * another board, for a guest without a seat in REVIEW, DONE or CANCELLED (E9, params `sessionId` only), and with `itemId` for a
     * card that is not one of the session. Takes the rate of [operation] (E17) - the one limit of join, leave, placement, estimate and
     * the moderator operations, before anything else is looked at; an unknown session id counts as well. Changes nothing.
     */
    suspend fun header(
        boardId: Uuid,
        sessionId: Uuid,
        principal: Principal,
        operation: SessionOperation,
        itemId: Uuid? = null,
    ): SessionHeader

    /** Takes a seat in the lobby (409 `PLANNING_SESSION_FULL` beyond the caps, E10); again while seated changes nothing. */
    suspend fun join(boardId: Uuid, sessionId: Uuid, principal: Principal)

    /** Gives up the caller's seat in the lobby; without a seat it changes nothing. */
    suspend fun leave(boardId: Uuid, sessionId: Uuid, principal: Principal)

    /** Starts with the picked seats (C3, E7); the moderator was checked by `api`. Audited. */
    suspend fun start(command: StartCommand): SessionView

    /** Ends the current phase or round early when [AdvanceCommand.state] and [AdvanceCommand.round] are the current ones (E14). */
    suspend fun advance(command: AdvanceCommand): SessionView

    /** REVIEW -> DONE. Audited with the number of decisions and of overridden ones. */
    suspend fun finish(boardId: Uuid, sessionId: Uuid, viewer: Viewer): SessionView

    /** Any active state -> CANCELLED; entries, reasons and moves are deleted at once (E22). Audited. */
    suspend fun cancel(boardId: Uuid, sessionId: Uuid, viewer: Viewer): SessionView

    /**
     * The link [shareId] was revoked (S1.13, E11): its seats leave every session in LOBBY, are marked removed in running phases (with
     * their entries, placements and moves gone and the cards they touched marked); from REVIEW on the record stands.
     */
    suspend fun removeGuestsOfShare(shareId: Uuid)

    /** Deletes the sessions of boards that were purged for good, with everything in them (S7.7). */
    suspend fun deleteBoardData(boardIds: Collection<Uuid>)

    /**
     * Reduces sessions that were DONE for 30 days at [now] to numbers: no reason, no seat of an entry, no move any more (E22; the answers
     * stop showing them at that time anyway). Returns how many were reduced.
     */
    suspend fun reduceExpired(now: Instant): Int
}

/** What a caller of [EstimationUseCase.header] is about to do, for its rate (E17). */
enum class SessionOperation { JOIN_OR_LEAVE, PLACE, ESTIMATE, MODERATE }

/** One card of a new session as the request names it. */
data class NewItemSpec(val ref: ItemRef, val title: String)

/** Input of [EstimationUseCase.create]; [anonymous] null means true (E5). */
data class NewSessionCommand(
    val boardId: Uuid,
    val moderator: Principal.Member,
    val mode: EstimationMode,
    val title: String,
    val deck: DeckSpec,
    val items: List<NewItemSpec>,
    val anonymous: Boolean?,
    val settings: SessionSettings,
)

/** Input of [EstimationUseCase.get]: [unchanged] tells whether the caller's `If-None-Match` names a version. */
class GetSessionQuery(val boardId: Uuid, val sessionId: Uuid, val viewer: Viewer, val unchanged: (Long) -> Boolean)

/** The answer of [EstimationUseCase.get]: the session, or 304 for [version]. */
sealed interface SessionAnswer {
    val version: Long

    class Found(val session: SessionView) : SessionAnswer {
        override val version: Long get() = session.version
    }

    class NotModified(override val version: Long) : SessionAnswer
}

/** Input of [EstimationUseCase.start]. */
data class StartCommand(val boardId: Uuid, val sessionId: Uuid, val viewer: Viewer, val seatIds: Set<Uuid>)

/** Input of [EstimationUseCase.advance]: the state and round the moderator's client believes are current. */
data class AdvanceCommand(val boardId: Uuid, val sessionId: Uuid, val viewer: Viewer, val state: SessionState, val round: Int)
