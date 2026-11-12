package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.common.PlanningModule
import at.dergeorg.drawboard.planning.domain.rounds.KeyedLocks
import at.dergeorg.drawboard.planning.domain.rounds.PlanningSettings
import at.dergeorg.drawboard.planning.domain.rounds.RoundResults
import at.dergeorg.drawboard.planning.domain.rounds.RoundRules
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantView
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundCancelled
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundCreated
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundHeader
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundRevealed
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundView
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredRound
import at.dergeorg.drawboard.planning.domain.rounds.provides.CastVoteCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.CreateRoundCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.GetRoundQuery
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.planning.domain.rounds.requires.GuestShares
import at.dergeorg.drawboard.planning.domain.rounds.requires.ParticipantRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.PlanningMetrics
import at.dergeorg.drawboard.planning.domain.rounds.requires.RoundRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.Transactions
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

/**
 * Implements the planning poker use cases (S7.6, M4 contract review). Rounds, participants and votes live only here - the Yjs
 * document is never read or written. What raises a round's `version` (the ETag of the polls): a participant joins, a participant
 * votes for the first time, the round is revealed or cancelled, guests are removed because their link was revoked. A changed vote
 * does not, because nobody else may notice it. The writes to one round run one after the other (one replica, [KeyedLocks]).
 */
@Service
@Suppress("TooManyFunctions")
internal class PlanningService(
    private val rounds: RoundRepository,
    private val participants: ParticipantRepository,
    private val transactions: Transactions,
    private val settings: PlanningSettings,
    private val audit: AuditTrail,
    private val metrics: PlanningMetrics,
    private val clock: Clock,
    private val guestShares: GuestShares,
) : PlanningUseCase {

    private val events = DomainEvents(PlanningModule.NAME)
    private val roundLocks = KeyedLocks()
    private val boardLocks = KeyedLocks()

    private val creates = limiter(settings.createsPerMinute)
    private val lists = limiter(settings.listsPerMinute)
    private val gets = limiter(settings.getsPerMinute)
    private val votes = limiter(settings.votesPerMinute)
    private val shareLists = limiter(settings.shareListsPerMinute)
    private val shareGets = limiter(settings.shareGetsPerMinute)
    private val shareVotes = limiter(settings.shareVotesPerMinute)

    private fun limiter(perMinute: Int) = WindowRateLimiter(clock, RateRule(perMinute, 1.minutes))

    @WithSpan
    override suspend fun create(command: CreateRoundCommand): RoundView {
        take(creates, command.facilitator.id.toString())
        val storyBlockId = RoundRules.storyBlockId(command.storyBlockId)
        val title = RoundRules.title(command.title)
        val deck = RoundRules.deck(command.deck)
        return boardLocks.withLock(command.boardId) {
            transactions.required {
                // One OPEN round per story card; quick rounds (no card) may be open side by side. The cap below counts both kinds.
                storyBlockId?.let { rounds.findOpenByStoryBlock(command.boardId, it) }?.let {
                    throw DomainException(
                        ErrorCode.PLANNING_ROUND_ALREADY_OPEN,
                        mapOf("storyBlockId" to storyBlockId, "roundId" to it.id.toString()),
                    )
                }
                if (rounds.count(command.boardId, RoundState.OPEN) >= settings.maxOpenRounds) {
                    throw DomainException(ErrorCode.PLANNING_ROUND_LIMIT_REACHED, mapOf("limit" to settings.maxOpenRounds.toString()))
                }
                pruneClosed(command.boardId)
                val round = rounds.insert(
                    StoredRound(
                        id = Uuid.generateV7(), boardId = command.boardId, storyBlockId = storyBlockId, title = title, deck = deck,
                        state = RoundState.OPEN, facilitatorId = command.facilitator.id, facilitatorName = command.facilitator.displayName,
                        createdAt = clock.now(), closedAt = null, revealedAt = null, version = FIRST_VERSION,
                    ),
                )
                audit.record(
                    events.of(
                        ROUND, round.id, AuditAction.CREATED, "created",
                        RoundCreated(round.boardId.toString(), storyBlockId, round.facilitatorId.toString(), deck.kind.name),
                    ),
                )
                metrics.round("started")
                checkNotNull(view(round, emptyList(), command.facilitator)) { "a facilitator sees the round they started" }
            }
        }
    }

    @WithSpan
    override suspend fun list(@SpanAttribute("board.id") boardId: Uuid, state: RoundState, viewer: Principal): List<RoundView> {
        limit(lists, shareLists, viewer, boardId)
        val found = rounds.findNewest(boardId, state, if (state == RoundState.OPEN) MAX_LIST_OPEN else MAX_LIST)
        // the participants (up to 200 rows a round) are loaded only for the rounds this caller may see at all: a guest sees a closed round
        // only as its participant, and that is one cheap lookup instead of every row of every round
        val visible = if (viewer is Principal.Guest && state != RoundState.OPEN) {
            val own = participants.roundIdsOf(found.map { it.id }, ParticipantKind.GUEST, viewer.id)
            found.filter { it.id in own }
        } else {
            found
        }
        val byRound = participants.findByRounds(visible.map { it.id }).groupBy { it.roundId }
        return visible.mapNotNull { view(it, byRound[it.id].orEmpty(), viewer) }
    }

    @WithSpan
    override suspend fun get(query: GetRoundQuery): RoundView {
        limit(gets, shareGets, query.viewer, query.roundId)
        val round = rounds.find(query.boardId, query.roundId) ?: throw notFound(query.roundId)
        val current = participants.findByRound(round.id)
        val joins = query.mayJoin && query.viewer is Principal.Member && round.state == RoundState.OPEN &&
            current.none { it.isPrincipal(query.viewer) }
        if (!joins) return view(round, current, query.viewer) ?: throw notFound(query.roundId)
        return roundLocks.withLock(round.id) { transactions.required { join(query) } }
    }

    /** The first fetch of an OPEN round by a member who may vote: the member is listed (and the version rises) unless the round is full. */
    private suspend fun join(query: GetRoundQuery): RoundView {
        var round = rounds.find(query.boardId, query.roundId) ?: throw notFound(query.roundId)
        var current = participants.findByRound(round.id)
        if (round.state == RoundState.OPEN && current.none { it.isPrincipal(query.viewer) }) {
            if (current.size >= settings.maxParticipants) {
                metrics.refused(REASON_FULL) // the caller still sees the round, only without being listed
            } else {
                add(round, current, query.viewer, vote = null)
                round = raise(round)
                current = participants.findByRound(round.id)
            }
        }
        return view(round, current, query.viewer) ?: throw notFound(query.roundId)
    }

    @WithSpan
    override suspend fun header(@SpanAttribute("board.id") boardId: Uuid, @SpanAttribute("round.id") roundId: Uuid): RoundHeader {
        val round = rounds.find(boardId, roundId) ?: throw notFound(roundId)
        return RoundHeader(round.facilitatorId, round.state)
    }

    @WithSpan
    override suspend fun vote(command: CastVoteCommand) {
        limit(votes, shareVotes, command.voter, command.roundId)
        roundLocks.withLock(command.roundId) {
            transactions.required {
                val round = rounds.find(command.boardId, command.roundId) ?: throw notFound(command.roundId)
                if (round.state != RoundState.OPEN) throw closed(round)
                // the value is not echoed: it is the caller's secret until the reveal
                if (command.value !in round.deck.values) {
                    throw DomainException(ErrorCode.PLANNING_VALUE_INVALID, mapOf("roundId" to round.id.toString()))
                }
                val current = participants.findByRound(round.id)
                val own = current.firstOrNull { it.isPrincipal(command.voter) }
                when {
                    own == null -> {
                        requireRoom(round, current, command.voter)
                        add(round, current, command.voter, command.value)
                        raise(round)
                    }
                    own.vote == null -> {
                        participants.setVote(own.id, command.value)
                        raise(round)
                    }
                    own.vote != command.value -> participants.setVote(own.id, command.value)
                }
                metrics.vote()
            }
        }
    }

    @WithSpan
    override suspend fun reveal(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        actor: Principal.Member,
    ): RoundView = roundLocks.withLock(roundId) {
        val revokedShares = revokedGuestShares(boardId, roundId)
        transactions.required {
            val round = rounds.find(boardId, roundId) ?: throw notFound(roundId)
            if (round.state != RoundState.OPEN) throw closed(round)
            val all = participants.findByRound(round.id)
            // safety net: a guest of a revoked link is not part of the result, whatever happened to removeGuestsOfShare
            val gone = all.filter { it.shareId in revokedShares }
            if (gone.isNotEmpty()) participants.deleteAll(gone.map { it.id })
            val current = all - gone.toSet()
            val now = clock.now()
            val revealed = round.copy(state = RoundState.REVEALED, revealedAt = now, closedAt = now, version = round.version + 1)
            rounds.update(revealed)
            val voted = current.filter { it.vote != null }
            audit.record(
                events.of(
                    ROUND, round.id, AuditAction.UPDATED, "revealed",
                    RoundRevealed(
                        boardId.toString(), round.storyBlockId, actor.id.toString(),
                        memberVotes = voted.count { !it.guest }, guestVotes = voted.count { it.guest },
                    ),
                ),
            )
            metrics.round("revealed")
            checkNotNull(view(revealed, current, actor)) { "the one who reveals sees the round" }
        }
    }

    @WithSpan
    override suspend fun cancel(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        actor: Principal.Member,
    ): RoundView = roundLocks.withLock(roundId) {
        transactions.required {
            val round = rounds.find(boardId, roundId) ?: throw notFound(roundId)
            if (round.state != RoundState.OPEN) throw closed(round)
            val current = participants.findByRound(round.id)
            participants.clearVotes(round.id) // gone at once, never revealed
            val cancelled = round.copy(state = RoundState.CANCELLED, closedAt = clock.now(), version = round.version + 1)
            rounds.update(cancelled)
            audit.record(
                events.of(
                    ROUND, round.id, AuditAction.UPDATED, "cancelled",
                    RoundCancelled(boardId.toString(), round.storyBlockId, actor.id.toString()),
                ),
            )
            metrics.round("cancelled")
            checkNotNull(view(cancelled, current.map { it.copy(vote = null) }, actor)) { "the one who cancels sees the round" }
        }
    }

    @WithSpan
    override suspend fun removeGuestsOfShare(@SpanAttribute("share.id") shareId: Uuid) {
        participants.findByShare(shareId).map { it.roundId }.distinct().forEach { roundId ->
            roundLocks.withLock(roundId) {
                transactions.required {
                    val round = rounds.findAllById(listOf(roundId)).singleOrNull()?.takeIf { it.state == RoundState.OPEN }
                    val ours = if (round == null) emptyList() else participants.findByRound(roundId).filter { it.shareId == shareId }
                    if (round != null && ours.isNotEmpty()) {
                        participants.deleteAll(ours.map { it.id })
                        raise(round)
                    }
                }
            }
        }
    }

    @WithSpan
    override suspend fun deleteBoardData(boardIds: Collection<Uuid>) {
        if (boardIds.isEmpty()) return
        transactions.required {
            val ids = rounds.idsOfBoards(boardIds)
            if (ids.isNotEmpty()) {
                participants.deleteByRounds(ids)
                rounds.deleteAll(ids)
            }
        }
    }

    /** The links of the guests of a round that are gone now; asked outside the transaction, the link is `library`'s. */
    private suspend fun revokedGuestShares(boardId: Uuid, roundId: Uuid): Set<Uuid> {
        if (rounds.find(boardId, roundId) == null) return emptySet() // the transaction answers 404
        val shares = participants.findByRound(roundId).mapNotNull { it.shareId }.toSet()
        return if (shares.isEmpty()) emptySet() else guestShares.revoked(shares)
    }

    /** Keeps at most `maxClosedRounds` closed rounds of the board: the oldest CANCELLED go first, then the oldest REVEALED, with their
     * votes. */
    private suspend fun pruneClosed(boardId: Uuid) {
        val cancelled = rounds.count(boardId, RoundState.CANCELLED)
        val revealed = rounds.count(boardId, RoundState.REVEALED)
        val surplus = cancelled + revealed - settings.maxClosedRounds
        if (surplus <= 0) return
        val firstGo = minOf(surplus, cancelled)
        val doomed = buildList {
            if (firstGo > 0) addAll(rounds.findOldest(boardId, RoundState.CANCELLED, firstGo))
            if (surplus > firstGo) addAll(rounds.findOldest(boardId, RoundState.REVEALED, surplus - firstGo))
        }.map { it.id }
        participants.deleteByRounds(doomed)
        rounds.deleteAll(doomed)
    }

    /** A new participant takes a seat. */
    private suspend fun add(round: StoredRound, current: List<StoredParticipant>, who: Principal, vote: String?) {
        val inserted = participants.insert(
            StoredParticipant(
                id = Uuid.generateV7(), roundId = round.id,
                kind = if (who is Principal.Guest) ParticipantKind.GUEST else ParticipantKind.USER,
                principalId = who.id, shareId = (who as? Principal.Guest)?.shareId, displayName = who.displayName,
                position = (current.maxOfOrNull { it.position } ?: 0) + 1, vote = vote, joinedAt = clock.now(),
            ),
        )
        if (!inserted) throw DomainException(ErrorCode.CONFLICT) // another instance added the same participant first
    }

    /** The caps of a round for a caller who is not a participant yet: 409 `PLANNING_ROUND_FULL` names the one that was hit. */
    private fun requireRoom(round: StoredRound, current: List<StoredParticipant>, who: Principal) {
        if (who is Principal.Guest) {
            if (current.count { it.shareId == who.shareId } >= settings.maxGuestsPerShare) full(round, settings.maxGuestsPerShare)
            if (current.count { it.guest } >= settings.maxGuests) full(round, settings.maxGuests)
        }
        if (current.size >= settings.maxParticipants) full(round, settings.maxParticipants)
    }

    private fun full(round: StoredRound, limit: Int): Nothing {
        metrics.refused(REASON_FULL)
        throw DomainException(ErrorCode.PLANNING_ROUND_FULL, mapOf("roundId" to round.id.toString(), "limit" to limit.toString()))
    }

    private suspend fun raise(round: StoredRound): StoredRound = round.copy(version = round.version + 1).also { rounds.update(it) }

    /**
     * The round as [viewer] sees it, or null if they must not see it: a guest sees a closed round only as its participant.
     * A value is shown to nobody while the round is OPEN but to its owner (`myVote`); a cancelled round has no votes left.
     */
    private fun view(round: StoredRound, current: List<StoredParticipant>, viewer: Principal): RoundView? {
        val own = current.firstOrNull { it.isPrincipal(viewer) }
        if (viewer is Principal.Guest && round.state != RoundState.OPEN && own == null) return null
        return RoundView(
            id = round.id, boardId = round.boardId, storyBlockId = round.storyBlockId, title = round.title, deck = round.deck,
            state = round.state, facilitatorId = round.facilitatorId, facilitatorName = round.facilitatorName,
            createdAt = round.createdAt, revealedAt = round.revealedAt, version = round.version,
            participants = current.map { ParticipantView(it.displayName, it.guest, it.vote != null,
                if (it.guest) null else it.principalId) },
            myVote = own?.vote,
            result = if (round.state == RoundState.REVEALED) RoundResults.of(round.deck, current) else null,
        )
    }

    private fun StoredParticipant.isPrincipal(who: Principal): Boolean =
        principalId == who.id && guest == (who is Principal.Guest)

    /** The rate of a caller on a round or board; a guest is counted by share as well, so many sessions of one link cannot multiply the
     * allowance. */
    private fun limit(perUser: WindowRateLimiter, perShare: WindowRateLimiter, who: Principal, scope: Uuid) {
        take(perUser, "${who.id}|$scope")
        if (who is Principal.Guest) take(perShare, "${who.shareId}|$scope")
    }

    private fun take(limiter: WindowRateLimiter, key: String) {
        try {
            limiter.take(key)
        } catch (e: RateLimitedException) {
            metrics.refused(REASON_RATE)
            throw e
        }
    }

    private fun notFound(roundId: Uuid) = DomainException(ErrorCode.PLANNING_ROUND_NOT_FOUND, mapOf("roundId" to roundId.toString()))

    private fun closed(round: StoredRound) =
        DomainException(ErrorCode.PLANNING_ROUND_CLOSED, mapOf("roundId" to round.id.toString(), "state" to round.state.name))

    private companion object {
        const val ROUND = "round"
        const val FIRST_VERSION = 1L
        const val MAX_LIST = 50
        const val MAX_LIST_OPEN = 20
        const val REASON_RATE = "rate_limit"
        const val REASON_FULL = "round_full"
    }
}
