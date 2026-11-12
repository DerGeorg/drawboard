package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredRound
import at.dergeorg.drawboard.planning.domain.rounds.requires.GuestShares
import at.dergeorg.drawboard.planning.domain.rounds.requires.ParticipantRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.PlanningMetrics
import at.dergeorg.drawboard.planning.domain.rounds.requires.RoundRepository
import at.dergeorg.drawboard.planning.domain.rounds.requires.Transactions
import kotlin.uuid.Uuid

internal class InMemoryRounds : RoundRepository {
    val rows = linkedMapOf<Uuid, StoredRound>()

    override suspend fun find(boardId: Uuid, roundId: Uuid) = rows[roundId]?.takeIf { it.boardId == boardId }

    override suspend fun findAllById(ids: Collection<Uuid>) = ids.mapNotNull { rows[it] }

    override suspend fun insert(round: StoredRound): StoredRound {
        check(round.id !in rows) { "duplicate id" }
        check(
            round.storyBlockId == null ||
                rows.values.none { it.boardId == round.boardId && it.storyBlockId == round.storyBlockId && it.state == RoundState.OPEN },
        ) { "the unique key: one OPEN round per story card (NULLs are distinct, as in PostgreSQL)" }
        rows[round.id] = round
        return round
    }

    override suspend fun update(round: StoredRound) {
        rows[round.id] = checkNotNull(rows[round.id]).copy(
            state = round.state, closedAt = round.closedAt ?: rows[round.id]?.closedAt,
            revealedAt = round.revealedAt ?: rows[round.id]?.revealedAt, version = round.version,
        )
    }

    override suspend fun findNewest(boardId: Uuid, state: RoundState, limit: Int) =
        rows.values.filter { it.boardId == boardId && it.state == state }.sortedWith(compareBy({ it.createdAt },
            { it.id })).reversed().take(limit)

    override suspend fun findOldest(boardId: Uuid, state: RoundState, limit: Int) =
        rows.values.filter { it.boardId == boardId && it.state == state }.sortedWith(compareBy({ it.closedAt }, { it.id })).take(limit)

    override suspend fun count(boardId: Uuid, state: RoundState) = rows.values.count { it.boardId == boardId && it.state == state }

    override suspend fun findOpenByStoryBlock(boardId: Uuid, storyBlockId: String) =
        rows.values.firstOrNull { it.boardId == boardId && it.storyBlockId == storyBlockId && it.state == RoundState.OPEN }

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        rows.keys.removeAll(ids.toSet())
    }

    override suspend fun idsOfBoards(boardIds: Collection<Uuid>) = rows.values.filter { it.boardId in boardIds }.map { it.id }
}

internal class InMemoryParticipants : ParticipantRepository {
    val rows = linkedMapOf<Uuid, StoredParticipant>()

    override suspend fun findByRound(roundId: Uuid) = rows.values.filter { it.roundId == roundId }.sortedBy { it.position }

    override suspend fun findByRounds(roundIds: Collection<Uuid>): List<StoredParticipant> {
        loaded += roundIds
        return rows.values.filter { it.roundId in roundIds }.sortedBy { it.position }
    }

    override suspend fun insert(participant: StoredParticipant): Boolean {
        val same = { row: StoredParticipant ->
            row.roundId == participant.roundId && row.kind == participant.kind && row.principalId == participant.principalId
        }
        if (rows.values.any(same)) {
            return false
        }
        rows[participant.id] = participant
        return true
    }

    override suspend fun setVote(id: Uuid, vote: String) {
        rows[id] = checkNotNull(rows[id]).copy(vote = vote)
    }

    override suspend fun clearVotes(roundId: Uuid) {
        rows.replaceAll { _, row -> if (row.roundId == roundId) row.copy(vote = null) else row }
    }

    var loaded = mutableListOf<Collection<Uuid>>() // the round ids findByRounds was asked for

    override suspend fun roundIdsOf(roundIds: Collection<Uuid>, kind: ParticipantKind, principalId: Uuid) =
        rows.values.filter { it.roundId in roundIds && it.kind == kind && it.principalId == principalId }.map { it.roundId }.toSet()

    override suspend fun findByShare(shareId: Uuid) = rows.values.filter { it.shareId == shareId }

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        rows.keys.removeAll(ids.toSet())
    }

    override suspend fun deleteByRounds(roundIds: Collection<Uuid>) {
        rows.values.removeAll { it.roundId in roundIds }
    }
}

/** The links that are gone; everything else is alive. */
internal class FakeGuestShares(val revoked: MutableSet<Uuid> = mutableSetOf()) : GuestShares {
    val asked = mutableListOf<Collection<Uuid>>()

    override suspend fun revoked(shareIds: Collection<Uuid>): Set<Uuid> {
        asked += shareIds
        return shareIds.filter { it in revoked }.toSet()
    }
}

internal object DirectTransactions : Transactions {
    override suspend fun <T> required(block: suspend () -> T): T = block()
}

internal class RecordingMetrics : PlanningMetrics {
    val rounds = mutableListOf<String>()
    var votes = 0
    val refused = mutableListOf<String>()

    override fun round(event: String) {
        rounds += event
    }

    override fun vote() {
        votes++
    }

    override fun refused(reason: String) {
        refused += reason
    }
}
