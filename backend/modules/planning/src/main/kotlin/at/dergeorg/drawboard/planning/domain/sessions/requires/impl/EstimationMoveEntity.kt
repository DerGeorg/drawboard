package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `planning.estimation_move`. */
@Table(schema = "planning", name = "estimation_move")
internal data class EstimationMoveEntity(
    @Id val id: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val seatId: Uuid?,
    val fromValue: String?,
    val toValue: String,
    val movedAt: Instant?,
    val seq: Long,
)
