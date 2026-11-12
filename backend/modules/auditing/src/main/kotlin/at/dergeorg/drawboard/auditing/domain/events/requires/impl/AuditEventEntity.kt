package at.dergeorg.drawboard.auditing.domain.events.requires.impl

import at.dergeorg.drawboard.auditing.domain.events.model.StoredAuditEvent
import io.r2dbc.postgresql.codec.Json
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `auditing.audit_event`. `io.r2dbc.postgresql.codec.Json` maps to jsonb without a custom converter. */
@Table(schema = "auditing", name = "audit_event")
internal data class AuditEventEntity(
    @Id val id: Uuid,
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
    val changes: Json?,
    val detailsType: String?,
    val details: Json?,
)

internal fun AuditEventEntity.toModel() = StoredAuditEvent(
    id = id,
    occurredAt = occurredAt,
    eventType = eventType,
    module = module,
    entityType = entityType,
    entityId = entityId,
    action = action,
    actorType = actorType,
    actorId = actorId,
    requestId = requestId,
    traceId = traceId,
    changes = changes?.asString(),
    detailsType = detailsType,
    details = details?.asString(),
)

internal fun StoredAuditEvent.toEntity() = AuditEventEntity(
    id = id,
    occurredAt = occurredAt,
    eventType = eventType,
    module = module,
    entityType = entityType,
    entityId = entityId,
    action = action,
    actorType = actorType,
    actorId = actorId,
    requestId = requestId,
    traceId = traceId,
    changes = changes?.let(Json::of),
    detailsType = detailsType,
    details = details?.let(Json::of),
)
