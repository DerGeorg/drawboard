package at.dergeorg.drawboard.planning.domain.rounds.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.domain.Limit
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.uuid.Uuid

/** Spring Data R2DBC repositories, derived queries only. Used by the adapters in this package only. */
internal interface RoundR2dbcRepository : CoroutineCrudRepository<RoundEntity, Uuid> {

    suspend fun findByBoardIdAndId(boardId: Uuid, id: Uuid): RoundEntity?

    fun findByBoardIdAndStateOrderByCreatedAtDescIdDesc(boardId: Uuid, state: String, limit: Limit): Flow<RoundEntity>

    fun findByBoardIdAndStateOrderByClosedAtAscIdAsc(boardId: Uuid, state: String, limit: Limit): Flow<RoundEntity>

    suspend fun countByBoardIdAndState(boardId: Uuid, state: String): Long

    suspend fun findByBoardIdAndStoryBlockIdAndState(boardId: Uuid, storyBlockId: String, state: String): RoundEntity?

    fun findByBoardIdIn(boardIds: Collection<Uuid>): Flow<RoundEntity>

    fun findByIdIn(ids: Collection<Uuid>): Flow<RoundEntity>
}

internal interface ParticipantR2dbcRepository : CoroutineCrudRepository<ParticipantEntity, Uuid> {

    fun findByRoundIdOrderByPositionAsc(roundId: Uuid): Flow<ParticipantEntity>

    fun findByRoundIdInOrderByPositionAsc(roundIds: Collection<Uuid>): Flow<ParticipantEntity>

    fun findByRoundIdInAndKindAndPrincipalId(roundIds: Collection<Uuid>, kind: String, principalId: Uuid): Flow<ParticipantEntity>

    fun findByShareId(shareId: Uuid): Flow<ParticipantEntity>

    suspend fun deleteByRoundIdIn(roundIds: Collection<Uuid>): Long
}
