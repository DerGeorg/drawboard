package at.dergeorg.drawboard.api.domain.planning.rounds.provides.impl

import at.dergeorg.drawboard.api.domain.planning.rounds.provides.PlanningApiUseCase
import at.dergeorg.drawboard.api.domain.planning.rounds.provides.RoundAnswer
import at.dergeorg.drawboard.api.domain.planning.sessions.provides.EstimationAnswer
import at.dergeorg.drawboard.api.domain.planning.sessions.provides.EstimationApiUseCase
import at.dergeorg.drawboard.contract.api.PlanningApi
import at.dergeorg.drawboard.contract.model.EstimationAdvance
import at.dergeorg.drawboard.contract.model.EstimationDecision
import at.dergeorg.drawboard.contract.model.EstimationEntry
import at.dergeorg.drawboard.contract.model.EstimationPlacement
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionList
import at.dergeorg.drawboard.contract.model.EstimationStart
import at.dergeorg.drawboard.contract.model.NewEstimationSession
import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.PokerRound
import at.dergeorg.drawboard.contract.model.PokerRoundList
import at.dergeorg.drawboard.contract.model.PokerVote
import at.dergeorg.drawboard.contract.model.RotationEstimate
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
 * HTTP only: implements the generated [PlanningApi] and delegates to [PlanningApiUseCase] (poker rounds) and [EstimationApiUseCase]
 * (estimation sessions). The route table in core lets guests through on the operations of the M4 review (list, get, vote) and of E8
 * (list, get, join, leave, placement, estimate); everything else is decided in the services. Every estimation answer carries
 * `Cache-Control: no-store` and `Vary: Authorization` (E18): the bodies depend on the caller, and an estimate answer holds a secret.
 */
@RestController
@Suppress("TooManyFunctions")
internal class PlanningController(
    private val planning: PlanningApiUseCase,
    private val estimation: EstimationApiUseCase,
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

    @WithSpan
    override suspend fun listEstimationSessions(
        @SpanAttribute("board.id") boardId: Uuid,
        state: String,
    ): ResponseEntity<EstimationSessionList> = private(HttpStatus.OK).body(estimation.listSessions(boardId, state))

    @WithSpan
    override suspend fun createEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        newEstimationSession: NewEstimationSession,
    ): ResponseEntity<EstimationSession> {
        val created = estimation.createSession(boardId, newEstimationSession)
        val location = UriComponentsBuilder.fromPath(basePath).path(PlanningApi.PATH_GET_ESTIMATION_SESSION)
            .buildAndExpand(boardId, created.id).toUri()
        return private(HttpStatus.CREATED).location(location).body(created)
    }

    /** 200 or 304, both with `ETag: W/"<version>"` (weak: the body depends on the caller). */
    @WithSpan
    override suspend fun getEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        ifNoneMatch: String?,
    ): ResponseEntity<EstimationSession> {
        val answer = estimation.getSession(boardId, sessionId, ifNoneMatch)
        val builder = private(if (answer is EstimationAnswer.NotModified) HttpStatus.NOT_MODIFIED else HttpStatus.OK)
            .eTag("W/\"${answer.version}\"")
        return when (answer) {
            is EstimationAnswer.Found -> builder.body(answer.session)
            is EstimationAnswer.NotModified -> builder.build()
        }
    }

    @WithSpan
    override suspend fun joinEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): ResponseEntity<Unit> {
        estimation.joinSession(boardId, sessionId)
        return private(HttpStatus.NO_CONTENT).build()
    }

    @WithSpan
    override suspend fun leaveEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): ResponseEntity<Unit> {
        estimation.leaveSession(boardId, sessionId)
        return private(HttpStatus.NO_CONTENT).build()
    }

    @WithSpan
    override suspend fun startEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        estimationStart: EstimationStart,
    ): ResponseEntity<EstimationSession> = private(HttpStatus.OK).body(estimation.startSession(boardId, sessionId, estimationStart))

    @WithSpan
    override suspend fun advanceEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        estimationAdvance: EstimationAdvance,
    ): ResponseEntity<EstimationSession> = private(HttpStatus.OK).body(estimation.advanceSession(boardId, sessionId, estimationAdvance))

    @WithSpan
    override suspend fun finishEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): ResponseEntity<EstimationSession> = private(HttpStatus.OK).body(estimation.finishSession(boardId, sessionId))

    @WithSpan
    override suspend fun cancelEstimationSession(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
    ): ResponseEntity<EstimationSession> = private(HttpStatus.OK).body(estimation.cancelSession(boardId, sessionId))

    @WithSpan
    override suspend fun placeEstimationItem(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        itemId: Uuid, // no span attribute: with a guest's request it would tie the card to a seat (B1)
        estimationPlacement: EstimationPlacement,
    ): ResponseEntity<Unit> {
        estimation.placeItem(boardId, sessionId, itemId, estimationPlacement)
        return private(HttpStatus.NO_CONTENT).build()
    }

    @WithSpan
    override suspend fun setRotationEstimate(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        itemId: Uuid, // no span attribute: with a guest's request it would tie the card to a seat (B1)
        rotationEstimate: RotationEstimate,
    ): ResponseEntity<EstimationEntry> = private(HttpStatus.OK).body(estimation.setEstimate(boardId, sessionId, itemId, rotationEstimate))

    @WithSpan
    override suspend fun decideEstimationItem(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("session.id") sessionId: Uuid,
        @SpanAttribute("item.id") itemId: Uuid,
        estimationDecision: EstimationDecision,
    ): ResponseEntity<Unit> {
        estimation.decideItem(boardId, sessionId, itemId, estimationDecision)
        return private(HttpStatus.NO_CONTENT).build()
    }

    /** An estimation answer: never stored by a browser or proxy, and different per caller (E18). */
    private fun private(status: HttpStatus) = ResponseEntity.status(status)
        .cacheControl(CacheControl.noStore())
        .header(HttpHeaders.VARY, HttpHeaders.AUTHORIZATION)
}
