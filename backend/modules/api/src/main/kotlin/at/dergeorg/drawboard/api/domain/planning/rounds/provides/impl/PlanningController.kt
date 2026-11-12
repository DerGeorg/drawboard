package at.dergeorg.drawboard.api.domain.planning.rounds.provides.impl

import at.dergeorg.drawboard.api.domain.planning.rounds.provides.PlanningApiUseCase
import at.dergeorg.drawboard.api.domain.planning.rounds.provides.RoundAnswer
import at.dergeorg.drawboard.contract.api.PlanningApi
import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.PokerRound
import at.dergeorg.drawboard.contract.model.PokerRoundList
import at.dergeorg.drawboard.contract.model.PokerVote
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [PlanningApi] and delegates to [PlanningApiUseCase]. The route table in core lets guests
 * through on the three operations of the M4 review (list, get, vote); everything else is decided in the service.
 */
@RestController
internal class PlanningController(
    private val planning: PlanningApiUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
) : PlanningApi {

    @WithSpan
    override suspend fun listPokerRounds(@SpanAttribute("board.id") boardId: Uuid, state: String): ResponseEntity<PokerRoundList> =
        ResponseEntity.ok(planning.listRounds(boardId, state))

    @WithSpan
    override suspend fun createPokerRound(
        @SpanAttribute("board.id") boardId: Uuid,
        newPokerRound: NewPokerRound,
    ): ResponseEntity<PokerRound> {
        val created = planning.createRound(boardId, newPokerRound)
        val location = UriComponentsBuilder.fromPath(basePath).path(PlanningApi.PATH_GET_POKER_ROUND).buildAndExpand(boardId,
            created.id).toUri()
        return ResponseEntity.created(location).body(created)
    }

    /**
     * 200 or 304, both with `ETag: W/"<version>"`, `Cache-Control: no-store` (so the browser hands a 304 to the script) and
     * `Vary: Authorization` (the body depends on the caller: `myVote`).
     */
    @WithSpan
    override suspend fun getPokerRound(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        ifNoneMatch: String?,
    ): ResponseEntity<PokerRound> {
        val answer = planning.getRound(boardId, roundId, ifNoneMatch)
        val builder = ResponseEntity.status(if (answer is RoundAnswer.NotModified) HttpStatus.NOT_MODIFIED else HttpStatus.OK)
            .eTag("W/\"${answer.version}\"")
            .cacheControl(CacheControl.noStore())
            .header(HttpHeaders.VARY, HttpHeaders.AUTHORIZATION)
        return when (answer) {
            is RoundAnswer.Found -> builder.body(answer.round)
            is RoundAnswer.NotModified -> builder.build()
        }
    }

    @WithSpan
    override suspend fun castPokerVote(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
        pokerVote: PokerVote,
    ): ResponseEntity<Unit> {
        planning.castVote(boardId, roundId, pokerVote)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun revealPokerRound(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
    ): ResponseEntity<PokerRound> = ResponseEntity.ok(planning.revealRound(boardId, roundId))

    @WithSpan
    override suspend fun cancelPokerRound(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("round.id") roundId: Uuid,
    ): ResponseEntity<PokerRound> = ResponseEntity.ok(planning.cancelRound(boardId, roundId))
}
