package at.dergeorg.drawboard.planning.domain.rounds.provides

import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundHeader
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundView
import kotlin.uuid.Uuid

/**
 * What the planning module offers: estimation rounds on story cards with their votes (S7.6). Like files and plugins it trusts
 * its caller (module `api`) with everything that needs a token, a role or a board: who may start, vote, reveal or cancel, and
 * that the board exists and is not in the trash. The module knows neither tokens, roles nor boards, and never the Yjs document.
 */
interface PlanningUseCase {

    /**
     * Starts a round. At most one OPEN round per story card (`PLANNING_ROUND_ALREADY_OPEN`) and 10 per board
     * (`PLANNING_ROUND_LIMIT_REACHED`), 10 rounds per user and minute (429). Prunes the closed rounds of the board to at most
     * 500 first. Audited.
     */
    suspend fun create(command: CreateRoundCommand): RoundView

    /** The rounds of the board in [state], newest first, at most 20 for OPEN and 50 otherwise, as [viewer] sees them. Joins nobody. */
    suspend fun list(boardId: Uuid, state: RoundState, viewer: Principal): List<RoundView>

    /**
     * One round as [GetRoundQuery.viewer] sees it. A member who may vote joins an OPEN round by this call (which raises the
     * version) unless it is full - then they see the round without being listed. A guest never joins here; a guest sees a
     * REVEALED or CANCELLED round only as its participant (else `PLANNING_ROUND_NOT_FOUND`).
     */
    suspend fun get(query: GetRoundQuery): RoundView

    /** Who started the round and in which state it is; `PLANNING_ROUND_NOT_FOUND` for a round of another board. No limit, no join. */
    suspend fun header(boardId: Uuid, roundId: Uuid): RoundHeader

    /** Sets or changes the vote of [CastVoteCommand.voter] and joins them if needed. */
    suspend fun vote(command: CastVoteCommand)

    /** Closes the round for good and reveals every vote (`PLANNING_ROUND_CLOSED` if it is not OPEN). Audited. */
    suspend fun reveal(boardId: Uuid, roundId: Uuid, actor: Principal.Member): RoundView

    /** Closes the round without a reveal and deletes its votes at once (`PLANNING_ROUND_CLOSED` if it is not OPEN). Audited. */
    suspend fun cancel(boardId: Uuid, roundId: Uuid, actor: Principal.Member): RoundView

    /**
     * Removes the guests that came through [shareId] from every OPEN round, with their votes, and raises those rounds' versions
     * (S1.13).
     */
    suspend fun removeGuestsOfShare(shareId: Uuid)

    /** Deletes the rounds of boards that were purged for good, with their participants and votes (S7.7). */
    suspend fun deleteBoardData(boardIds: Collection<Uuid>)
}

/** The deck of a new round as the request names it: [values] only for [DeckKind.CUSTOM] (the other decks are fixed). */
data class DeckSpec(val kind: DeckKind, val values: List<String>?)

/** Input of [PlanningUseCase.create]; [facilitator] is the editor or owner who starts it, [storyBlockId] null for a quick round. */
data class CreateRoundCommand(
    val boardId: Uuid,
    val storyBlockId: String?,
    val title: String,
    val deck: DeckSpec,
    val facilitator: Principal.Member,
)

/** Input of [PlanningUseCase.get]: [mayJoin] is true when [viewer] is a member with the role COMMENTER or higher. */
data class GetRoundQuery(val boardId: Uuid, val roundId: Uuid, val viewer: Principal, val mayJoin: Boolean)

/** Input of [PlanningUseCase.vote]. */
data class CastVoteCommand(val boardId: Uuid, val roundId: Uuid, val voter: Principal, val value: String)
