package at.dergeorg.drawboard.auditing.domain.events.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** One stored audit event, persistence-neutral: the JSON columns are plain strings here. */
internal data class StoredAuditEvent(
    val id: Uuid,
    val occurredAt: Instant,
    val eventType: String,
    val module: String,
    val entityType: String,
    val entityId: String,
    val action: String,
    val actorType: String,
    val actorId: String?,
    val requestId: String?,
    val traceId: String?,
    val changes: String?,
    val detailsType: String?,
    val details: String?,
)
