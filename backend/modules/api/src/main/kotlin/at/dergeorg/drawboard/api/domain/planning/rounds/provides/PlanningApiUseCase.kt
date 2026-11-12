package at.dergeorg.drawboard.api.domain.planning.rounds.provides

import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.PokerRound
import at.dergeorg.drawboard.contract.model.PokerRoundList
import at.dergeorg.drawboard.contract.model.PokerVote
import kotlin.uuid.Uuid

/** The planning part of the API in contract types: the rounds of a board, the votes, the reveal. */
interface PlanningApiUseCase {

    suspend fun listRounds(boardId: Uuid, state: String): PokerRoundList

    suspend fun createRound(boardId: Uuid, request: NewPokerRound): PokerRound

    /** The round, or [RoundAnswer.NotModified] when [ifNoneMatch] names the current version. */
    suspend fun getRound(boardId: Uuid, roundId: Uuid, ifNoneMatch: String?): RoundAnswer

    suspend fun castVote(boardId: Uuid, roundId: Uuid, vote: PokerVote)

    suspend fun revealRound(boardId: Uuid, roundId: Uuid): PokerRound

    suspend fun cancelRound(boardId: Uuid, roundId: Uuid): PokerRound
}

/** The answer of getPokerRound: 200 with the round, or 304 without a body - both carry the ETag `W/"<version>"`. */
sealed interface RoundAnswer {
    val version: Long

    class Found(val round: PokerRound) : RoundAnswer {
        override val version: Long get() = round.version
    }

    class NotModified(override val version: Long) : RoundAnswer
}
