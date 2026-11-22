package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.EstimationAdvance
import at.dergeorg.drawboard.contract.model.EstimationDecision
import at.dergeorg.drawboard.contract.model.EstimationItemRef
import at.dergeorg.drawboard.contract.model.EstimationItemRefKind
import at.dergeorg.drawboard.contract.model.EstimationMode
import at.dergeorg.drawboard.contract.model.EstimationPlacement
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionState
import at.dergeorg.drawboard.contract.model.EstimationSettings
import at.dergeorg.drawboard.contract.model.EstimationStart
import at.dergeorg.drawboard.contract.model.NewEstimationItem
import at.dergeorg.drawboard.contract.model.NewEstimationSession
import at.dergeorg.drawboard.contract.model.PokerDeck
import at.dergeorg.drawboard.contract.model.PokerDeckKind
import at.dergeorg.drawboard.contract.model.RotationEstimate
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import kotlin.test.assertEquals
import kotlin.uuid.Uuid

// The estimation sessions over HTTP for the integration tests: the same [Actor] as poker (a client with an Authorization header).

val MAGIC_SETTINGS = EstimationSettings(placingSeconds = 60, movingSeconds = 120)

fun rotationSettings(rounds: Int = 2, advanceWhenDone: Boolean = false) =
    EstimationSettings(rounds = rounds, roundSeconds = 60, advanceWhenDone = advanceWhenDone)

fun storyCards(count: Int): List<NewEstimationItem> =
    List(count) { NewEstimationItem(EstimationItemRef(EstimationItemRefKind.STORY, Uuid.random().toString()), "Story $it") }

fun newSession(
    mode: EstimationMode = EstimationMode.ROTATION,
    items: List<NewEstimationItem> = storyCards(4),
    settings: EstimationSettings = if (mode == EstimationMode.MAGIC) MAGIC_SETTINGS else rotationSettings(),
    anonymous: Boolean? = null,
    title: String = "Sprint 42",
    deck: PokerDeck = PokerDeck(PokerDeckKind.FIBONACCI),
) = NewEstimationSession(mode = mode, title = title, deck = deck, items = items, settings = settings, anonymous = anonymous)

private fun sessions(boardId: Uuid) = "/api/boards/$boardId/estimation-sessions"

fun Actor.createSession(boardId: Uuid, request: NewEstimationSession = newSession()) = call(HttpMethod.POST, sessions(boardId), request)

/** Creates a session and expects 201; returns it. */
fun Actor.openSession(read: EstimationJson, boardId: Uuid, request: NewEstimationSession = newSession()): EstimationSession {
    val reply = createSession(boardId, request)
    assertEquals(HttpStatus.CREATED, reply.status, "creating a session, body ${reply.body}")
    return read.session(reply)
}

fun Actor.listSessions(boardId: Uuid, state: String? = null) =
    call(HttpMethod.GET, sessions(boardId) + (state?.let { "?state=$it" } ?: ""))

fun Actor.getSession(boardId: Uuid, sessionId: Uuid, ifNoneMatch: String? = null) = call(
    HttpMethod.GET, "${sessions(boardId)}/$sessionId",
    headers = ifNoneMatch?.let { mapOf(HttpHeaders.IF_NONE_MATCH to it) }.orEmpty(),
)

/** getEstimationSession, expecting 200. */
fun Actor.lookAt(read: EstimationJson, boardId: Uuid, sessionId: Uuid): EstimationSession {
    val reply = getSession(boardId, sessionId)
    assertEquals(HttpStatus.OK, reply.status, "reading the session, body ${reply.body}")
    return read.session(reply)
}

fun Actor.joinSession(boardId: Uuid, sessionId: Uuid) = call(HttpMethod.PUT, "${sessions(boardId)}/$sessionId/seats/me")

fun Actor.leaveSession(boardId: Uuid, sessionId: Uuid) = call(HttpMethod.DELETE, "${sessions(boardId)}/$sessionId/seats/me")

fun Actor.startSession(boardId: Uuid, sessionId: Uuid, seatIds: Set<Uuid>) =
    call(HttpMethod.POST, "${sessions(boardId)}/$sessionId/start", EstimationStart(seatIds))

fun Actor.advanceSession(boardId: Uuid, sessionId: Uuid, state: EstimationSessionState, round: Int = 0) =
    call(HttpMethod.POST, "${sessions(boardId)}/$sessionId/advance", EstimationAdvance(state, round))

fun Actor.finishSession(boardId: Uuid, sessionId: Uuid) = call(HttpMethod.POST, "${sessions(boardId)}/$sessionId/finish")

fun Actor.cancelSession(boardId: Uuid, sessionId: Uuid) = call(HttpMethod.POST, "${sessions(boardId)}/$sessionId/cancel")

fun Actor.placeCard(boardId: Uuid, sessionId: Uuid, itemId: Uuid, value: String?, state: EstimationSessionState? = null) =
    call(HttpMethod.PUT, "${sessions(boardId)}/$sessionId/items/$itemId/placement", EstimationPlacement(value, state))

fun Actor.estimateCard(boardId: Uuid, sessionId: Uuid, itemId: Uuid, value: String, reason: String? = null, round: Int? = null) =
    call(HttpMethod.PUT, "${sessions(boardId)}/$sessionId/items/$itemId/estimate", RotationEstimate(value, reason, round))

fun Actor.decideCard(boardId: Uuid, sessionId: Uuid, itemId: Uuid, value: String) =
    call(HttpMethod.PUT, "${sessions(boardId)}/$sessionId/items/$itemId/decision", EstimationDecision(value))
