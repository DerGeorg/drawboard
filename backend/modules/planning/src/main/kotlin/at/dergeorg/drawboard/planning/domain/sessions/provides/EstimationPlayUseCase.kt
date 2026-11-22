package at.dergeorg.drawboard.planning.domain.sessions.provides

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import kotlin.uuid.Uuid

/**
 * What the seats enter and what the moderator decides in a running or reviewed session: Magic placements and moves, Rotation
 * estimates, decisions. `api` asked [EstimationUseCase.header] and decided the role first; from there each operation keeps the order
 * of refusals C2: seat (403 `PLANNING_NOT_SEATED`) -> state and expected round (409 `PLANNING_SESSION_WRONG_STATE`) -> card held
 * (409 `PLANNING_ITEM_NOT_HELD`) -> value (400 `PLANNING_VALUE_INVALID`) -> reason (400 `PLANNING_REASON_REQUIRED`) -> move limits
 * (409 `PLANNING_MOVE_LIMIT_REACHED`). No value or reason is echoed, logged, traced or audited (E12, E23).
 */
interface EstimationPlayUseCase {

    /** MAGIC: puts a card into a column ([PlaceCommand.value] null takes an own card out, PLACING only) or moves it (MOVING). */
    suspend fun place(command: PlaceCommand)

    /** ROTATION: keeps or changes the estimate of a card the caller holds in the current round; returns the caller's entry only. */
    suspend fun estimate(command: EstimateCommand): EntryView

    /** REVIEW: records the moderator's decision for a card (E13, server-enforced); `api` checked that the caller moderates. */
    suspend fun decide(command: DecideCommand)
}

/** Input of [EstimationPlayUseCase.place]; [state] is the phase the client believes is current (E14). */
data class PlaceCommand(
    val boardId: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val principal: Principal,
    val value: String?,
    val state: SessionState?,
)

/** Input of [EstimationPlayUseCase.estimate]; [round] is the round the client believes is current (E14). */
data class EstimateCommand(
    val boardId: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val principal: Principal,
    val value: String,
    val reason: String?,
    val round: Int?,
)

/** Input of [EstimationPlayUseCase.decide]. */
data class DecideCommand(val boardId: Uuid, val sessionId: Uuid, val itemId: Uuid, val moderator: Principal.Member, val value: String)
