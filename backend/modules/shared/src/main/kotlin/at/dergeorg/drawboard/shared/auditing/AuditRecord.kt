package at.dergeorg.drawboard.shared.auditing

import at.dergeorg.drawboard.shared.context.Actor
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** A stored audit event as the read side returns it. */
data class AuditRecord(
    val id: Uuid,
    val occurredAt: Instant,
    val eventType: String,
    val module: String,
    val entityType: String,
    val entityId: String,
    val action: AuditAction,
    val actor: Actor,
    val requestId: String?,
    val traceId: String?,
    val changes: List<FieldChange>,
    /** Typed details; [UnknownDetails] if the stored type is not (or no longer) known to this build. */
    val details: DomainEventDetails?,
) {
    /** Typed access: `record.detailsAs<TaskCompleted>()`. */
    inline fun <reified D : DomainEventDetails> detailsAs(): D? = details as? D
}

/** One changed property. [path] uses dots for nested objects (`address.city`). */
data class FieldChange(val path: String, val before: Any?, val after: Any?)

/** Details whose type is not registered (class removed, or written by a newer version). The raw JSON is kept. */
data class UnknownDetails(val type: String?, val json: String) : DomainEventDetails

/** Criteria for reading audit events. All optional, combined with AND; [from] inclusive, [to] exclusive. */
data class AuditFilter(
    val module: String? = null,
    val entityType: String? = null,
    val entityId: String? = null,
    val eventTypes: Set<String> = emptySet(),
    val actorId: String? = null,
    val requestId: String? = null,
    val traceId: String? = null,
    val from: Instant? = null,
    val to: Instant? = null,
)
