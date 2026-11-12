package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
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
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundView
import at.dergeorg.drawboard.planning.domain.rounds.provides.CastVoteCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.CreateRoundCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.rounds.provides.GetRoundQuery
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
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
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val profiles: UserProfilesUseCase,
    private val planning: PlanningUseCase,
) : PlanningApiUseCase {

    @WithSpan
    override suspend fun listRounds(@SpanAttribute("board.id") boardId: Uuid, state: String): PokerRoundList {
        val wanted = RoundState.valueOf(state) // the contract's pattern lets only the three names through
        val access = access(boardId)
        if (access.guest != null && wanted != RoundState.OPEN) throw DomainException(ErrorCode.FORBIDDEN)
        val rounds = planning.list(boardId, wanted, access.principal)
        val names = namesOf(rounds.flatMap(::userIds))
        return PokerRoundList(items = rounds.map { toContract(it, access.guest != null, names) })
    }

    @WithSpan
    override suspend fun createRound(@SpanAttribute("board.id") boardId: Uuid, request: NewPokerRound): PokerRound {
        val member = requireMember(boardId, "EDITOR or OWNER") { it == BoardRole.OWNER || it == BoardRole.EDITOR }
        val deck = DeckSpec(request.deck.kind.toDomain(), request.deck.propertyValues)
        val created = planning.create(CreateRoundCommand(boardId, request.storyBlockId, request.title, deck, member.principal))
        return toContract(created, hideMembers = false, namesOf(userIds(created)))
    }

    @WithSpan
    override suspend fun getRound(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        ifNoneMatch: String?,
    ): RoundAnswer {
        val access = access(boardId)
        val mayJoin = access.guest == null && access.role != BoardRole.VIEWER
        val round = planning.get(GetRoundQuery(boardId, roundId, access.principal, mayJoin))
        if (matches(ifNoneMatch, round.version)) return RoundAnswer.NotModified(round.version)
        return RoundAnswer.Found(toContract(round, access.guest != null, namesOf(userIds(round))))
    }

    @WithSpan
    override suspend fun castVote(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid, vote: PokerVote) {
        val access = access(boardId)
        // a member needs COMMENTER or higher; a VIEWER may look but not take part
        if (access.guest == null && access.role == BoardRole.VIEWER) throw accessDenied(boardId, "COMMENTER or higher")
        planning.vote(CastVoteCommand(boardId, roundId, access.principal, vote.value))
    }

    @WithSpan
    override suspend fun revealRound(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid): PokerRound {
        val member = requireCloser(boardId, roundId)
        val revealed = planning.reveal(boardId, roundId, member.principal)
        return toContract(revealed, hideMembers = false, namesOf(userIds(revealed)))
    }

    @WithSpan
    override suspend fun cancelRound(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid): PokerRound {
        val member = requireCloser(boardId, roundId)
        val cancelled = planning.cancel(boardId, roundId, member.principal)
        return toContract(cancelled, hideMembers = false, namesOf(userIds(cancelled)))
    }

    /** Who asks and what they may be: a signed-in member with the role on the board, or a guest with the role of its link. */
    private class Access(val principal: Principal, val role: BoardRole, val guest: CurrentGuest?)

    private class Member(val principal: Principal.Member, val role: BoardRole)

    /**
     * The caller on [boardId] for the operations guests share with members: no role = the board does not exist for the caller (404,
     * also for a board in the trash); a guest needs a COMMENTER or EDITOR link, otherwise 403 `FORBIDDEN` (S1.8, M4 review).
     */
    private suspend fun access(boardId: Uuid): Access {
        val guest = callers.guestOrNull()
        val caller = callers.any()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (guest != null) {
            if (role != BoardRole.COMMENTER && role != BoardRole.EDITOR) throw DomainException(ErrorCode.FORBIDDEN)
            return Access(Principal.Guest(guest.id, guest.name, guest.shareId), role, guest)
        }
        return Access(memberOf(), role, null)
    }

    private suspend fun requireMember(boardId: Uuid, required: String, allowed: (BoardRole) -> Boolean): Member {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
        val caller = signedIn.caller()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (!allowed(role)) throw accessDenied(boardId, required)
        return Member(memberOf(), role)
    }

    /** Reveal and cancel: the round must exist first (404), then the facilitator who is still an editor, or the owner (403). */
    private suspend fun requireCloser(boardId: Uuid, roundId: Uuid): Member {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
        val member = requireMember(boardId, "EDITOR or OWNER") { it == BoardRole.OWNER || it == BoardRole.EDITOR }
        val header = planning.header(boardId, roundId)
        if (member.role != BoardRole.OWNER && header.facilitatorId != member.principal.id) {
            throw accessDenied(boardId, "the facilitator or OWNER")
        }
        return member
    }

    private suspend fun memberOf(): Principal.Member {
        val profile = signedIn.profile()
        return Principal.Member(profile.id, profile.displayName?.takeIf { it.isNotBlank() } ?: profile.username)
    }

    /**
     * Weak comparison of `If-None-Match` (RFC 9110) with the ETag `W/"<version>"`; `*` counts as no match (M4 contract), so a client
     * that has nothing cached always gets the round. The list may hold several tags.
     */
    private fun matches(ifNoneMatch: String?, version: Long): Boolean =
        ifNoneMatch != null && ifNoneMatch.split(',').map { it.trim().removePrefix("W/") }.any { it == "\"$version\"" }

    private fun userIds(round: RoundView): List<Uuid> =
        listOf(round.facilitatorId) + round.participants.mapNotNull { it.userId } + round.result?.votes.orEmpty().mapNotNull { it.userId }

    /** Display names as they were when the participant joined - except that a user who does not exist any more reads "Deleted user". */
    private class NameBook(private val existing: Set<Uuid>) {
        fun name(userId: Uuid?, stored: String): String = if (userId != null && userId !in existing) DELETED_USER else stored
    }

    private suspend fun namesOf(ids: Collection<Uuid>): NameBook =
        NameBook(if (ids.isEmpty()) emptySet() else profiles.findAllById(ids.toSet()).map { it.id }.toSet())

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

    private fun boardNotFound(boardId: Uuid) = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))

    private fun accessDenied(boardId: Uuid, required: String) =
        DomainException(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, mapOf("boardId" to boardId.toString(), "required" to required))

}

private const val DELETED_USER = "Deleted user"
