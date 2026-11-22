package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.domain.Limit
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Spring Data R2DBC repositories of the estimation sessions, derived queries only. Used by the adapters in this package only. */
internal interface EstimationSessionR2dbcRepository : CoroutineCrudRepository<EstimationSessionEntity, Uuid> {

    suspend fun findByBoardIdAndId(boardId: Uuid, id: Uuid): EstimationSessionEntity?

    fun findByIdIn(ids: Collection<Uuid>): Flow<EstimationSessionEntity>

    fun findByBoardIdAndStateInOrderByCreatedAtDescIdDesc(
        boardId: Uuid,
        states: Collection<String>,
        limit: Limit,
    ): Flow<EstimationSessionEntity>

    fun findByBoardIdAndStateOrderByClosedAtAscIdAsc(boardId: Uuid, state: String, limit: Limit): Flow<EstimationSessionEntity>

    suspend fun countByBoardIdAndStateIn(boardId: Uuid, states: Collection<String>): Long

    fun findByStateAndReducedAtIsNullAndClosedAtBefore(
        state: String,
        closedBefore: Instant,
        limit: Limit,
    ): Flow<EstimationSessionEntity>

    fun findByBoardIdIn(boardIds: Collection<Uuid>): Flow<EstimationSessionEntity>
}

internal interface EstimationSeatR2dbcRepository : CoroutineCrudRepository<EstimationSeatEntity, Uuid> {

    fun findBySessionIdOrderByPositionAsc(sessionId: Uuid): Flow<EstimationSeatEntity>

    fun findBySessionIdInOrderByPositionAsc(sessionIds: Collection<Uuid>): Flow<EstimationSeatEntity>

    suspend fun findBySessionIdAndKindAndPrincipalId(sessionId: Uuid, kind: String, principalId: Uuid): EstimationSeatEntity?

    fun findByShareId(shareId: Uuid): Flow<EstimationSeatEntity>

    suspend fun deleteBySessionIdIn(sessionIds: Collection<Uuid>): Long
}

internal interface EstimationItemR2dbcRepository : CoroutineCrudRepository<EstimationItemEntity, Uuid> {

    fun findBySessionIdOrderByPositionAsc(sessionId: Uuid): Flow<EstimationItemEntity>

    suspend fun findBySessionIdAndId(sessionId: Uuid, id: Uuid): EstimationItemEntity?

    suspend fun deleteBySessionIdIn(sessionIds: Collection<Uuid>): Long
}

internal interface EstimationEntryR2dbcRepository : CoroutineCrudRepository<EstimationEntryEntity, Uuid> {

    fun findBySessionIdOrderByShuffleAscIdAsc(sessionId: Uuid): Flow<EstimationEntryEntity>

    suspend fun deleteBySessionIdAndSeatId(sessionId: Uuid, seatId: Uuid): Long

    suspend fun deleteBySessionIdIn(sessionIds: Collection<Uuid>): Long
}

internal interface EstimationMoveR2dbcRepository : CoroutineCrudRepository<EstimationMoveEntity, Uuid> {

    fun findBySessionIdOrderBySeqAsc(sessionId: Uuid): Flow<EstimationMoveEntity>

    fun findByItemIdOrderBySeqAsc(itemId: Uuid): Flow<EstimationMoveEntity>

    suspend fun findFirstBySessionIdOrderBySeqDesc(sessionId: Uuid): EstimationMoveEntity?

    suspend fun countBySessionIdAndSeatId(sessionId: Uuid, seatId: Uuid): Long

    suspend fun countBySessionId(sessionId: Uuid): Long

    suspend fun deleteBySessionIdAndSeatId(sessionId: Uuid, seatId: Uuid): Long

    suspend fun deleteBySessionIdIn(sessionIds: Collection<Uuid>): Long
}
