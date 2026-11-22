package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.api.domain.planning.rounds.provides.PlanningApiUseCase
import at.dergeorg.drawboard.api.domain.planning.rounds.provides.RoundAnswer
import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.PokerDeck
import at.dergeorg.drawboard.contract.model.PokerDeckKind
import at.dergeorg.drawboard.contract.model.PokerParticipant
import at.dergeorg.drawboard.contract.model.PokerResult
import at.dergeorg.drawboard.contract.model.PokerResultVote
import at.dergeorg.drawboard.contract.model.PokerRound
import at.dergeorg.drawboard.contract.model.PokerRoundList
import at.dergeorg.drawboard.contract.model.PokerRoundState
import at.dergeorg.drawboard.contract.model.PokerValueCount
import at.dergeorg.drawboard.contract.model.PokerVote
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundView
import at.dergeorg.drawboard.planning.domain.rounds.provides.CastVoteCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.CreateRoundCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.rounds.provides.GetRoundQuery
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the API use cases of the planning module (S7.6, the M4 contract review): who may do what comes from the role on the
 * board, and a guest only from the role of its link. The planning module trusts this check - it knows no token, role or board.
 *
 * * list, get: every role; vote: COMMENTER or higher; create: EDITOR or OWNER, signed in; reveal, cancel: the facilitator while still
 *   EDITOR or OWNER, or the OWNER of the board.
 * * Guests (S1.8): only with a COMMENTER or EDITOR link, only list (state OPEN), get and vote; VIEWER-link guests and every other
 *   operation are 403 `FORBIDDEN`. A guest never sees the id of a member (`facilitatorId` is left out).
 * * The server never touches the Yjs document: after the reveal the client of the facilitator writes the estimate into the story card.
 */
@Service
@Suppress("TooManyFunctions")
internal class PlanningApiService(
    private val access: PlanningAccess,
    private val planning: PlanningUseCase,
) : PlanningApiUseCase {

    @WithSpan
    override suspend fun listRounds(@SpanAttribute("board.id") boardId: Uuid, state: String): PokerRoundList {
        val wanted = RoundState.valueOf(state) // the contract's pattern lets only the three names through
        val seen = access.access(boardId)
        if (seen.guest != null && wanted != RoundState.OPEN) throw DomainException(ErrorCode.FORBIDDEN)
        val rounds = planning.list(boardId, wanted, seen.principal)
        val names = access.namesOf(rounds.flatMap(::userIds))
        return PokerRoundList(items = rounds.map { toContract(it, seen.guest != null, names) })
    }

    @WithSpan
    override suspend fun createRound(@SpanAttribute("board.id") boardId: Uuid, request: NewPokerRound): PokerRound {
        val member = access.requireMember(boardId, "EDITOR or OWNER") { it == BoardRole.OWNER || it == BoardRole.EDITOR }
        val deck = DeckSpec(request.deck.kind.toDomain(), request.deck.propertyValues)
        val created = planning.create(CreateRoundCommand(boardId, request.storyBlockId, request.title, deck, member.principal))
        return toContract(created, hideMembers = false, access.namesOf(userIds(created)))
    }

    @WithSpan
    override suspend fun getRound(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        ifNoneMatch: String?,
    ): RoundAnswer {
        val seen = access.access(boardId)
        val mayJoin = seen.guest == null && seen.role != BoardRole.VIEWER
        val round = planning.get(GetRoundQuery(boardId, roundId, seen.principal, mayJoin))
        if (access.matches(ifNoneMatch, round.version)) return RoundAnswer.NotModified(round.version)
        return RoundAnswer.Found(toContract(round, seen.guest != null, access.namesOf(userIds(round))))
    }

    @WithSpan
    override suspend fun castVote(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid, vote: PokerVote) {
        val seen = access.access(boardId)
        // a member needs COMMENTER or higher; a VIEWER may look but not take part
        if (seen.guest == null && seen.role == BoardRole.VIEWER) throw access.accessDenied(boardId, "COMMENTER or higher")
        planning.vote(CastVoteCommand(boardId, roundId, seen.principal, vote.value))
    }

    @WithSpan
    override suspend fun revealRound(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid): PokerRound {
        val member = requireCloser(boardId, roundId)
        val revealed = planning.reveal(boardId, roundId, member.principal)
        return toContract(revealed, hideMembers = false, access.namesOf(userIds(revealed)))
    }

    @WithSpan
    override suspend fun cancelRound(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid): PokerRound {
        val member = requireCloser(boardId, roundId)
        val cancelled = planning.cancel(boardId, roundId, member.principal)
        return toContract(cancelled, hideMembers = false, access.namesOf(userIds(cancelled)))
    }

    /** Reveal and cancel: the round must exist first (404), then the facilitator who is still an editor, or the owner (403). */
    private suspend fun requireCloser(boardId: Uuid, roundId: Uuid): PlanningAccess.Member {
        access.denyGuest()
        val member = access.requireMember(boardId, "EDITOR or OWNER") { it == BoardRole.OWNER || it == BoardRole.EDITOR }
        val header = planning.header(boardId, roundId)
        if (member.role != BoardRole.OWNER && header.facilitatorId != member.principal.id) {
            throw access.accessDenied(boardId, "the facilitator or OWNER")
        }
        return member
    }

    private fun userIds(round: RoundView): List<Uuid> =
        listOf(round.facilitatorId) + round.participants.mapNotNull { it.userId } + round.result?.votes.orEmpty().mapNotNull { it.userId }

    private fun toContract(round: RoundView, hideMembers: Boolean, names: NameBook): PokerRound = PokerRound(
        id = round.id, storyBlockId = round.storyBlockId, title = round.title,
        deck = PokerDeck(round.deck.kind.toContract(), round.deck.values), state = round.state.toContract(),
        facilitatorName = names.name(round.facilitatorId, round.facilitatorName), createdAt = round.createdAt, version = round.version,
        participants = round.participants.map { PokerParticipant(names.name(it.userId, it.displayName), it.guest, it.voted) },
        facilitatorId = if (hideMembers) null else round.facilitatorId, revealedAt = round.revealedAt, myVote = round.myVote,
        result = round.result?.let { result ->
            PokerResult(
                votes = result.votes.map { PokerResultVote(names.name(it.userId, it.displayName), it.guest, it.value) },
                distribution = result.distribution.map { PokerValueCount(it.value, it.count) },
                average = result.average, median = result.median, suggestion = result.suggestion,
            )
        },
    )

    private fun DeckKind.toContract() = PokerDeckKind.valueOf(name)

    private fun PokerDeckKind.toDomain() = DeckKind.valueOf(name)

    private fun RoundState.toContract() = PokerRoundState.valueOf(name)
}
