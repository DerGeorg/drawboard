package at.dergeorg.drawboard.planning.domain.rounds.requires

import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredParticipant
import at.dergeorg.drawboard.planning.domain.rounds.model.StoredRound
import kotlin.uuid.Uuid

/** Port: the rounds. */
internal interface RoundRepository {

    /** The round, but only if it belongs to [boardId] - a round of another board does not exist for the caller. */
    suspend fun find(boardId: Uuid, roundId: Uuid): StoredRound?

    suspend fun findAllById(ids: Collection<Uuid>): List<StoredRound>

    suspend fun insert(round: StoredRound): StoredRound

    /** Writes state, times and version of [round]. */
    suspend fun update(round: StoredRound)

    /** Newest first, at most [limit]. */
    suspend fun findNewest(boardId: Uuid, state: RoundState, limit: Int): List<StoredRound>

    /** Oldest closed first (by the time they were closed), at most [limit]. */
    suspend fun findOldest(boardId: Uuid, state: RoundState, limit: Int): List<StoredRound>

    suspend fun count(boardId: Uuid, state: RoundState): Int

    suspend fun findOpenByStoryBlock(boardId: Uuid, storyBlockId: String): StoredRound?

    /** Deletes the rounds; their participants must be gone already. */
    suspend fun deleteAll(ids: Collection<Uuid>)

    /** The ids of every round of these boards, in any state. */
    suspend fun idsOfBoards(boardIds: Collection<Uuid>): List<Uuid>
}

/** Port: the participants of the rounds, with their votes. */
internal interface ParticipantRepository {

    /** In the order they joined. */
    suspend fun findByRound(roundId: Uuid): List<StoredParticipant>

    suspend fun findByRounds(roundIds: Collection<Uuid>): List<StoredParticipant>

    /** [participant] is new: false if its (round, kind, principal) exists already (a concurrent join won). */
    suspend fun insert(participant: StoredParticipant): Boolean

    suspend fun setVote(id: Uuid, vote: String)

    /** Deletes every vote of the round (a cancel); the participants stay. */
    suspend fun clearVotes(roundId: Uuid)

    /** The ids among [roundIds] in which the participant of this [kind] and [principalId] takes part. */
    suspend fun roundIdsOf(roundIds: Collection<Uuid>, kind: ParticipantKind, principalId: Uuid): Set<Uuid>

    /** Every row of a guest link, in any round. */
    suspend fun findByShare(shareId: Uuid): List<StoredParticipant>

    suspend fun deleteAll(ids: Collection<Uuid>)

    suspend fun deleteByRounds(roundIds: Collection<Uuid>)
}

/** Port: a short database transaction around [block]. */
internal interface Transactions {
    suspend fun <T> required(block: suspend () -> T): T
}

/** Port: the numbers about planning that Grafana shows. No label carries personal data. */
internal interface PlanningMetrics {

    /** A round was started, revealed or cancelled ([event]: `started`, `revealed`, `cancelled`). */
    fun round(event: String)

    /** A vote was stored (a new one or a changed one). */
    fun vote()

    /** A request was refused by a limit ([reason]: `rate_limit` or `round_full`) - the numbers behind S7.3. */
    fun refused(reason: String)
}

/**
 * Port: which guest links are gone. The planning module knows no links; module `api` implements this on top of `library` (the same
 * way it connects collab to the boards). A safety net for the reveal: `removeGuestsOfShare` runs after the revoke committed and can
 * fail on its own, and a guest of a revoked link must not show up in a result.
 */
interface GuestShares {

    /** The ids among [shareIds] whose link is revoked, expired or whose resource is gone; the others are not in the result. */
    suspend fun revoked(shareIds: Collection<Uuid>): Set<Uuid>
}
