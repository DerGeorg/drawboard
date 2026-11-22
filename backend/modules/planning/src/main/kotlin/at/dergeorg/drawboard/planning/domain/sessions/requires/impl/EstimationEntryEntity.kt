package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `planning.estimation_entry`. */
@Table(schema = "planning", name = "estimation_entry")
internal data class EstimationEntryEntity(
    @Id val id: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val seatId: Uuid?,
    val round: Int,
    val estimate: String,
    val reason: String?,
    val kept: Boolean,
    val shuffle: Long,
    val createdAt: Instant?,
)
