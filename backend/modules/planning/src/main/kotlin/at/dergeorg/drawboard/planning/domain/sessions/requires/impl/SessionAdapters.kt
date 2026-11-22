package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.sessions.SessionRules
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRefKind
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.requires.EntryRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.ItemRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.MoveRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SeatRepository
import at.dergeorg.drawboard.planning.domain.sessions.requires.SessionRepository
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
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
import org.springframework.stereotype.Repository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements the domain's [SessionRepository] port. A new session is INSERTed on purpose (the id is ours: `save()` could not tell it is
 * new); an update names the version it read, so a second writer fails loudly (E15) instead of losing a transition.
 */
@Repository
internal class SessionRepositoryAdapter(
    private val sessions: EstimationSessionR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : SessionRepository {

    @WithSpan
    override suspend fun find(boardId: Uuid, sessionId: Uuid): StoredSession? = sessions.findByBoardIdAndId(boardId, sessionId)?.toDomain()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<StoredSession> =
        if (ids.isEmpty()) emptyList() else sessions.findByIdIn(ids).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun insert(session: StoredSession) {
        template.insert(session.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun update(before: StoredSession, after: StoredSession) {
        check(before.id == after.id) { "one session" }
        val rows = template.update(EstimationSessionEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(after.id).and("version").`is`(before.version)))
            .apply(
                Update.update("state", after.state.name)
                    .set("round", after.round)
                    .set("phaseEndsAt", after.phaseEndsAt)
                    .set("startedAt", after.startedAt)
                    .set("closedAt", after.closedAt)
                    .set("lastActivityAt", after.lastActivityAt)
                    .set("reducedAt", after.reducedAt)
                    .set("version", after.version),
            )
            .awaitSingle()
        if (rows != 1L) throw DomainException(ErrorCode.CONFLICT) // another writer changed the session first
    }

    @WithSpan
    override suspend fun findNewest(boardId: Uuid, states: Collection<SessionState>, limit: Int): List<StoredSession> =
        sessions.findByBoardIdAndStateInOrderByCreatedAtDescIdDesc(boardId, states.map { it.name }, Limit.of(limit))
            .map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findOldest(boardId: Uuid, state: SessionState, limit: Int): List<StoredSession> =
        sessions.findByBoardIdAndStateOrderByClosedAtAscIdAsc(boardId, state.name, Limit.of(limit)).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun count(boardId: Uuid, states: Collection<SessionState>): Int =
        sessions.countByBoardIdAndStateIn(boardId, states.map { it.name }).toInt()

    @WithSpan
    override suspend fun findExpired(closedBefore: Instant, limit: Int): List<StoredSession> =
        sessions.findByStateAndReducedAtIsNullAndClosedAtBefore(SessionState.DONE.name, closedBefore, Limit.of(limit))
            .map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) sessions.deleteAllById(ids)
    }

    @WithSpan
    override suspend fun idsOfBoards(boardIds: Collection<Uuid>): List<Uuid> =
        if (boardIds.isEmpty()) emptyList() else sessions.findByBoardIdIn(boardIds).map { it.id }.toList()

    private fun EstimationSessionEntity.toDomain() = StoredSession(
        id = id,
        boardId = boardId,
        mode = EstimationMode.valueOf(mode),
        title = title,
        deck = Deck(DeckKind.valueOf(deckKind), deckValues.split(SEPARATOR)),
        anonymous = anonymous,
        settings = SessionSettings(
            placingSeconds = placingSeconds,
            movingSeconds = movingSeconds,
            markThreshold = markThreshold,
            rounds = rounds,
            roundSeconds = roundSeconds,
            advanceWhenDone = advanceWhenDone,
        ),
        state = SessionState.valueOf(state),
        round = round,
        phaseEndsAt = phaseEndsAt,
        moderatorId = moderatorId,
        moderatorName = moderatorName,
        itemCount = itemCount,
        createdAt = createdAt,
        startedAt = startedAt,
        closedAt = closedAt,
        lastActivityAt = lastActivityAt,
        reducedAt = reducedAt,
        version = version,
    )

    private fun StoredSession.toEntity() = EstimationSessionEntity(
        id = id,
        boardId = boardId,
        mode = mode.name,
        title = title,
        deckKind = deck.kind.name,
        deckValues = deck.values.joinToString(SEPARATOR),
        anonymous = anonymous,
        placingSeconds = settings.placingSeconds,
        movingSeconds = settings.movingSeconds,
        markThreshold = settings.markThreshold,
        rounds = settings.rounds,
        roundSeconds = settings.roundSeconds,
        advanceWhenDone = settings.advanceWhenDone,
        state = state.name,
        round = round,
        phaseEndsAt = phaseEndsAt,
        moderatorId = moderatorId,
        moderatorName = moderatorName,
        itemCount = itemCount,
        createdAt = createdAt,
        startedAt = startedAt,
        closedAt = closedAt,
        lastActivityAt = lastActivityAt,
        reducedAt = reducedAt,
        version = version,
    )

    private companion object {
        const val SEPARATOR = "\n"
    }
}

/** Implements the domain's [SeatRepository] port; a double join is stopped by the unique key (session, kind, principal). */
@Repository
internal class SeatRepositoryAdapter(
    private val seats: EstimationSeatR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : SeatRepository {

    @WithSpan
    override suspend fun findBySession(sessionId: Uuid): List<StoredSeat> =
        seats.findBySessionIdOrderByPositionAsc(sessionId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findBySessions(sessionIds: Collection<Uuid>): List<StoredSeat> =
        if (sessionIds.isEmpty()) emptyList() else seats.findBySessionIdInOrderByPositionAsc(sessionIds).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findOwn(sessionId: Uuid, kind: ParticipantKind, principalId: Uuid): StoredSeat? =
        seats.findBySessionIdAndKindAndPrincipalId(sessionId, kind.name, principalId)?.toDomain()

    @WithSpan
    override suspend fun insert(seat: StoredSeat): Boolean = try {
        template.insert(seat.toEntity()).awaitSingle()
        true
    } catch (_: DataIntegrityViolationException) {
        false
    }

    @WithSpan
    override suspend fun updateAll(seats: Collection<StoredSeat>) {
        seats.forEach { template.update(it.toEntity()).awaitSingle() }
    }

    @WithSpan
    override suspend fun findByShare(shareId: Uuid): List<StoredSeat> = seats.findByShareId(shareId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun deleteAll(ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) seats.deleteAllById(ids)
    }

    @WithSpan
    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        if (sessionIds.isNotEmpty()) seats.deleteBySessionIdIn(sessionIds)
    }

    @WithSpan
    override suspend fun clearSlots(sessionId: Uuid) {
        template.update(EstimationSeatEntity::class.java)
            .matching(Query.query(Criteria.where("sessionId").`is`(sessionId)))
            .apply(Update.update("slot", null))
            .awaitSingle()
    }

    private fun EstimationSeatEntity.toDomain() = StoredSeat(
        id = id,
        sessionId = sessionId,
        kind = ParticipantKind.valueOf(kind),
        principalId = principalId,
        shareId = shareId,
        displayName = displayName,
        position = position,
        joinedAt = joinedAt,
        seated = seated,
        slot = slot,
        removed = removed,
    )

    private fun StoredSeat.toEntity() = EstimationSeatEntity(
        id = id,
        sessionId = sessionId,
        kind = kind.name,
        principalId = principalId,
        shareId = shareId,
        displayName = displayName,
        position = position,
        joinedAt = joinedAt,
        seated = seated,
        slot = slot,
        removed = removed,
    )
}

/** Implements the domain's [ItemRepository] port; one ref per session is backed by a unique key. */
@Repository
internal class ItemRepositoryAdapter(
    private val items: EstimationItemR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : ItemRepository {

    @WithSpan
    override suspend fun findBySession(sessionId: Uuid): List<StoredItem> =
        items.findBySessionIdOrderByPositionAsc(sessionId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun find(sessionId: Uuid, itemId: Uuid): StoredItem? = items.findBySessionIdAndId(sessionId, itemId)?.toDomain()

    @WithSpan
    override suspend fun insertAll(items: List<StoredItem>) {
        items.forEach { template.insert(it.toEntity()).awaitSingle() }
    }

    @WithSpan
    override suspend fun updateAll(items: Collection<StoredItem>) {
        items.forEach { template.update(it.toEntity()).awaitSingle() }
    }

    @WithSpan
    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        if (sessionIds.isNotEmpty()) items.deleteBySessionIdIn(sessionIds)
    }

    private fun EstimationItemEntity.toDomain() = StoredItem(
        id = id,
        sessionId = sessionId,
        position = position,
        ref = ItemRef(ItemRefKind.valueOf(refKind), blockId, cardId),
        title = title,
        column = columnValue,
        moveCount = moveCount,
        marked = marked,
        touched = touched,
        decision = decision,
        overridden = overridden,
    )

    private fun StoredItem.toEntity() = EstimationItemEntity(
        id = id,
        sessionId = sessionId,
        position = position,
        refKind = ref.kind.name,
        blockId = ref.blockId,
        cardId = ref.cardId,
        refKey = SessionRules.key(ref),
        title = title,
        columnValue = column,
        moveCount = moveCount,
        marked = marked,
        touched = touched,
        decision = decision,
        overridden = overridden,
    )
}

/** Implements the domain's [EntryRepository] port; one entry per card and round is backed by a unique key. */
@Repository
internal class EntryRepositoryAdapter(
    private val entries: EstimationEntryR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : EntryRepository {

    @WithSpan
    override suspend fun findBySession(sessionId: Uuid): List<StoredEntry> =
        entries.findBySessionIdOrderByShuffleAscIdAsc(sessionId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun insert(entry: StoredEntry) {
        template.insert(entry.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun update(entry: StoredEntry) {
        template.update(entry.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid) {
        entries.deleteBySessionIdAndSeatId(sessionId, seatId)
    }

    @WithSpan
    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        if (sessionIds.isNotEmpty()) entries.deleteBySessionIdIn(sessionIds)
    }

    @WithSpan
    override suspend fun unlink(sessionId: Uuid, reasons: Boolean) {
        var update = Update.update("seatId", null).set("createdAt", null)
        if (reasons) update = update.set("reason", null)
        template.update(EstimationEntryEntity::class.java)
            .matching(Query.query(Criteria.where("sessionId").`is`(sessionId)))
            .apply(update)
            .awaitSingle()
    }

    private fun EstimationEntryEntity.toDomain() = StoredEntry(
        id = id,
        sessionId = sessionId,
        itemId = itemId,
        seatId = seatId,
        round = round,
        value = estimate,
        reason = reason,
        kept = kept,
        shuffle = shuffle,
        createdAt = createdAt,
    )

    private fun StoredEntry.toEntity() = EstimationEntryEntity(
        id = id,
        sessionId = sessionId,
        itemId = itemId,
        seatId = seatId,
        round = round,
        estimate = value,
        reason = reason,
        kept = kept,
        shuffle = shuffle,
        createdAt = createdAt,
    )
}

/** Implements the domain's [MoveRepository] port. */
@Repository
internal class MoveRepositoryAdapter(
    private val moves: EstimationMoveR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : MoveRepository {

    @WithSpan
    override suspend fun findBySession(sessionId: Uuid): List<StoredMove> =
        moves.findBySessionIdOrderBySeqAsc(sessionId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findByItem(itemId: Uuid): List<StoredMove> =
        moves.findByItemIdOrderBySeqAsc(itemId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun nextSeq(sessionId: Uuid): Long = (moves.findFirstBySessionIdOrderBySeqDesc(sessionId)?.seq ?: 0) + 1

    @WithSpan
    override suspend fun countBySeat(sessionId: Uuid, seatId: Uuid): Int = moves.countBySessionIdAndSeatId(sessionId, seatId).toInt()

    @WithSpan
    override suspend fun countBySession(sessionId: Uuid): Int = moves.countBySessionId(sessionId).toInt()

    @WithSpan
    override suspend fun insert(move: StoredMove) {
        template.insert(move.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun update(move: StoredMove) {
        template.update(move.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun delete(id: Uuid) {
        moves.deleteById(id)
    }

    @WithSpan
    override suspend fun deleteBySeat(sessionId: Uuid, seatId: Uuid) {
        moves.deleteBySessionIdAndSeatId(sessionId, seatId)
    }

    @WithSpan
    override suspend fun deleteBySessions(sessionIds: Collection<Uuid>) {
        if (sessionIds.isNotEmpty()) moves.deleteBySessionIdIn(sessionIds)
    }

    @WithSpan
    override suspend fun unlink(sessionId: Uuid) {
        template.update(EstimationMoveEntity::class.java)
            .matching(Query.query(Criteria.where("sessionId").`is`(sessionId)))
            .apply(Update.update("seatId", null).set("movedAt", null))
            .awaitSingle()
    }

    private fun EstimationMoveEntity.toDomain() = StoredMove(
        id = id,
        sessionId = sessionId,
        itemId = itemId,
        seatId = seatId,
        fromValue = fromValue,
        toValue = toValue,
        at = movedAt,
        seq = seq,
    )

    private fun StoredMove.toEntity() = EstimationMoveEntity(
        id = id,
        sessionId = sessionId,
        itemId = itemId,
        seatId = seatId,
        fromValue = fromValue,
        toValue = toValue,
        movedAt = at,
        seq = seq,
    )
}
