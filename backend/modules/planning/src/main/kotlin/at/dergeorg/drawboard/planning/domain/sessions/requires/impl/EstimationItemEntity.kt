package at.dergeorg.drawboard.planning.domain.sessions.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.uuid.Uuid

/** Row of `planning.estimation_item`. */
@Table(schema = "planning", name = "estimation_item")
internal data class EstimationItemEntity(
    @Id val id: Uuid,
    val sessionId: Uuid,
    val position: Int,
    val refKind: String,
    val blockId: String,
    val cardId: String?,
    val refKey: String,
    val title: String,
    val columnValue: String?,
    val moveCount: Int,
    val marked: Boolean,
    val touched: Boolean,
    val decision: String?,
    val overridden: Boolean,
)
