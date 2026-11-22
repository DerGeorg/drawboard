package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `planning.estimation_session`. Only used inside requires/impl; the domain sees `StoredSession`. */
@Table(schema = "planning", name = "estimation_session")
internal data class EstimationSessionEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val mode: String,
    val title: String,
    val deckKind: String,
    /** The cards, separated by a line feed (a card never contains one: control characters are rejected). */
    val deckValues: String,
    val anonymous: Boolean,
    val placingSeconds: Int?,
    val movingSeconds: Int?,
    val markThreshold: Int?,
    val rounds: Int?,
    val roundSeconds: Int?,
    val advanceWhenDone: Boolean?,
    val state: String,
    val round: Int,
    val phaseEndsAt: Instant?,
    val moderatorId: Uuid,
    val moderatorName: String,
    val itemCount: Int,
    val createdAt: Instant,
    val startedAt: Instant?,
    val closedAt: Instant?,
    val lastActivityAt: Instant,
    val reducedAt: Instant?,
    val version: Long,
)
