package at.dergeorg.drawboard.auditing.domain

import at.dergeorg.drawboard.auditing.common.AuditJson
import at.dergeorg.drawboard.auditing.domain.events.model.StoredAuditEvent
import at.dergeorg.drawboard.auditing.domain.events.requires.AuditEventStore
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.auditing.AuditRecord
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvent
import at.dergeorg.drawboard.shared.context.Actor
import at.dergeorg.drawboard.shared.context.ActorType
import at.dergeorg.drawboard.shared.context.RequestContextProvider
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.uuid.Uuid

/**
 * Implements both auditing ports from shared ([AuditTrail], [AuditLog]); the domain modules only ever see those
 * interfaces. Actor, request id and trace id are taken from the current request here, once - call sites only
 * describe what happened.
 */
@Service
internal class AuditingService(
    private val store: AuditEventStore,
    private val json: AuditJson,
    private val requestContext: RequestContextProvider,
    private val clock: Clock,
) : AuditTrail, AuditLog {

    /** REQUIRED: joins the caller's reactive transaction (it travels in the coroutine's Reactor context). */
    @WithSpan
    @Transactional
    override suspend fun record(event: DomainEvent<*>): Uuid {
        val context = requestContext.current()
        val now = clock.now()
        val changes = json.diff(event.before, event.after)
        val details = event.details
        val stored = StoredAuditEvent(
            id = Uuid.generateV7(),
            occurredAt = now,
            eventType = event.eventType,
            module = event.module,
            entityType = event.entityType,
            entityId = event.entityId,
            action = event.action.name,
            actorType = context.actor.type.name,
            actorId = context.actor.id,
            requestId = context.requestId,
            traceId = context.traceId,
            changes = changes.takeIf { it.isNotEmpty() }?.let(json::writeChanges),
            detailsType = details?.let(json::detailsTypeOf),
            details = details?.let(json::writeDetails),
        )
        store.insert(stored)
        return stored.id
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun find(filter: AuditFilter, page: PageQuery): Page<AuditRecord> =
        store.find(filter, page).map(::toRecord)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun history(
        @SpanAttribute("audit.entity_type") entityType: String,
        @SpanAttribute("audit.entity_id") entityId: String,
    ): List<AuditRecord> = store.history(entityType, entityId).map(::toRecord)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun latestPerEntity(
        @SpanAttribute("audit.entity_type") entityType: String,
        entityIds: Collection<String>?,
    ): List<AuditRecord> = store.latestPerEntity(entityType, entityIds).map(::toRecord)

    private fun toRecord(event: StoredAuditEvent) = AuditRecord(
        id = event.id,
        occurredAt = event.occurredAt,
        eventType = event.eventType,
        module = event.module,
        entityType = event.entityType,
        entityId = event.entityId,
        action = AuditAction.valueOf(event.action),
        actor = Actor(ActorType.valueOf(event.actorType), event.actorId),
        requestId = event.requestId,
        traceId = event.traceId,
        changes = event.changes?.let(json::readChanges).orEmpty(),
        details = event.details?.let(json::readDetails),
    )
}
