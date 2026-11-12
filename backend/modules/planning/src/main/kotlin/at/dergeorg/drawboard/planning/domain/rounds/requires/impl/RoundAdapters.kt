package at.dergeorg.drawboard.planning.domain.rounds.requires.impl

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredRound
import at.dergeorg.drawboard.planning.domain.rounds.requires.ParticipantRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.RoundRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.Transactions
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.data.domain.Limit
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.data.relational.core.query.Update
import org.springframework.stereotype.Component
import org.springframework.stereotype.Repository
import org.springframework.transaction.reactive.TransactionalOperator
import org.springframework.transaction.reactive.executeAndAwait
import kotlin.uuid.Uuid

/** Implements the domain's [RoundRepository] port. A new round is INSERTed on purpose (the id is ours: `save()` could not tell it is
 * new). */
@Repository
internal class RoundRepositoryAdapter(
    private val rounds: RoundR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : RoundRepository {

    @WithSpan
    override suspend fun find(boardId: Uuid, roundId: Uuid): StoredRound? = rounds.findByBoardIdAndId(boardId, roundId)?.toDomain()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<StoredRound> =
        if (ids.isEmpty()) emptyList() else rounds.findByIdIn(ids).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun insert(round: StoredRound): StoredRound {
        template.insert(round.toEntity()).awaitSingle()
        return round
    }

    @WithSpan
    override suspend fun update(round: StoredRound) {
        template.update(RoundEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(round.id)))
            .apply(changes(round))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun findNewest(boardId: Uuid, state: RoundState, limit: Int): List<StoredRound> =
        rounds.findByBoardIdAndStateOrderByCreatedAtDescIdDesc(boardId, state.name, Limit.of(limit)).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findOldest(boardId: Uuid, state: RoundState, limit: Int): List<StoredRound> =
        rounds.findByBoardIdAndStateOrderByClosedAtAscIdAsc(boardId, state.name, Limit.of(limit)).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun count(boardId: Uuid, state: RoundState): Int = rounds.countByBoardIdAndState(boardId, state.name).toInt()

    @WithSpan
    override suspend fun findOpenByStoryBlock(boardId: Uuid, storyBlockId: String): StoredRound? =
        rounds.findByBoardIdAndStoryBlockIdAndState(boardId, storyBlockId, RoundState.OPEN.name)?.toDomain()

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) rounds.deleteAllById(ids)
    }

    @WithSpan
    override suspend fun idsOfBoards(boardIds: Collection<Uuid>): List<Uuid> =
        if (boardIds.isEmpty()) emptyList() else rounds.findByBoardIdIn(boardIds).map { it.id }.toList()

    /** The columns that change after the start; the times are set once, so a null one is left alone. */
    private fun changes(round: StoredRound): Update {
        var update = Update.update("state", round.state.name).set("version", round.version)
        round.closedAt?.let { update = update.set("closedAt", it) }
        round.revealedAt?.let { update = update.set("revealedAt", it) }
        return update
    }

    private fun RoundEntity.toDomain() = StoredRound(
        id = id, boardId = boardId, storyBlockId = storyBlockId, title = title,
        deck = Deck(DeckKind.valueOf(deckKind), deckValues.split(SEPARATOR)), state = RoundState.valueOf(state),
        facilitatorId = facilitatorId, facilitatorName = facilitatorName, createdAt = createdAt, closedAt = closedAt,
        revealedAt = revealedAt, version = version,
    )

    private fun StoredRound.toEntity() = RoundEntity(
        id = id, boardId = boardId, storyBlockId = storyBlockId, title = title, deckKind = deck.kind.name,
        deckValues = deck.values.joinToString(SEPARATOR), state = state.name, facilitatorId = facilitatorId,
        facilitatorName = facilitatorName, createdAt = createdAt, closedAt = closedAt, revealedAt = revealedAt, version = version,
    )

    private companion object {
        const val SEPARATOR = "\n"
    }
}

/** Implements the domain's [ParticipantRepository] port; a double join is stopped by the unique key (round, kind, principal). */
@Repository
internal class ParticipantRepositoryAdapter(
    private val participants: ParticipantR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : ParticipantRepository {

    @WithSpan
    override suspend fun findByRound(roundId: Uuid): List<StoredParticipant> =
        participants.findByRoundIdOrderByPositionAsc(roundId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findByRounds(roundIds: Collection<Uuid>): List<StoredParticipant> =
        if (roundIds.isEmpty()) emptyList() else participants.findByRoundIdInOrderByPositionAsc(roundIds).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun insert(participant: StoredParticipant): Boolean = try {
        template.insert(participant.toEntity()).awaitSingle()
        true
    } catch (_: DataIntegrityViolationException) {
        false
    }

    @WithSpan
    override suspend fun setVote(id: Uuid, vote: String) {
        template.update(ParticipantEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(id)))
            .apply(Update.update("vote", vote))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun clearVotes(roundId: Uuid) {
        template.update(ParticipantEntity::class.java)
            .matching(Query.query(Criteria.where("roundId").`is`(roundId)))
            .apply(Update.update("vote", null))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun roundIdsOf(roundIds: Collection<Uuid>, kind: ParticipantKind, principalId: Uuid): Set<Uuid> =
        if (roundIds.isEmpty()) {
            emptySet()
        } else {
            participants.findByRoundIdInAndKindAndPrincipalId(roundIds, kind.name, principalId).map { it.roundId }.toList().toSet()
        }

    @WithSpan
    override suspend fun findByShare(shareId: Uuid): List<StoredParticipant> =
        participants.findByShareId(shareId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) participants.deleteAllById(ids)
    }

    @WithSpan
    override suspend fun deleteByRounds(roundIds: Collection<Uuid>) {
        if (roundIds.isNotEmpty()) participants.deleteByRoundIdIn(roundIds)
    }

    private fun ParticipantEntity.toDomain() = StoredParticipant(
        id = id, roundId = roundId, kind = ParticipantKind.valueOf(kind), principalId = principalId, shareId = shareId,
        displayName = displayName, position = position, vote = vote, joinedAt = joinedAt,
    )

    private fun StoredParticipant.toEntity() = ParticipantEntity(
        id = id, roundId = roundId, kind = kind.name, principalId = principalId, shareId = shareId, displayName = displayName,
        position = position, vote = vote, joinedAt = joinedAt,
    )
}

/** The [Transactions] port on the reactive transaction manager: REQUIRED, like `@Transactional`. */
@Component
internal class PlanningTransactions(private val operator: TransactionalOperator) : Transactions {

    @Suppress("UNCHECKED_CAST")
    override suspend fun <T> required(block: suspend () -> T): T = operator.executeAndAwait { block() } as T
}
