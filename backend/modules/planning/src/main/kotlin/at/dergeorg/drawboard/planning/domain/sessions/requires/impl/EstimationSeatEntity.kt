package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `planning.estimation_seat`. */
@Table(schema = "planning", name = "estimation_seat")
internal data class EstimationSeatEntity(
    @Id val id: Uuid,
    val sessionId: Uuid,
    val kind: String,
    val principalId: Uuid,
    val shareId: Uuid?,
    val displayName: String,
    val position: Int,
    val joinedAt: Instant,
    val seated: Boolean,
    val slot: Int?,
    val removed: Boolean,
)
