package at.dergeorg.drawboard.auditing.domain.events.requires.impl

import at.dergeorg.drawboard.auditing.domain.events.model.StoredAuditEvent
import at.dergeorg.drawboard.auditing.domain.events.requires.AuditEventStore
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactive.asFlow
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.data.domain.Sort
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.stereotype.Repository

/**
 * R2DBC adapter of [AuditEventStore] - append-only by construction: it can insert and read, nothing else (ArchUnit
 * checks that nothing in auditing calls update or delete). Inserts go through [R2dbcEntityTemplate.insert], which
 * always INSERTs (a repository's `save()` would take the set id for "exists" and UPDATE). Reads use a derived query
 * ([AuditEventR2dbcRepository]), Criteria for the optional filter, and one documented native query.
 */
@Repository
internal class R2dbcAuditEventStore(
    private val template: R2dbcEntityTemplate,
    private val events: AuditEventR2dbcRepository,
) : AuditEventStore {

    @WithSpan
    override suspend fun insert(event: StoredAuditEvent) {
        template.insert(event.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun find(filter: AuditFilter, page: PageQuery): Page<StoredAuditEvent> {
        val query = Query.query(filter.toCriteria())
        val total = template.count(query, AuditEventEntity::class.java).awaitSingle()
        val items = template.select(query.sort(NEWEST_FIRST).limit(page.size).offset(page.offset), AuditEventEntity::class.java)
            .asFlow().map { it.toModel() }.toList()
        return Page(items, page, total)
    }

    @WithSpan
    override suspend fun history(entityType: String, entityId: String): List<StoredAuditEvent> =
        events.findAllByEntityTypeAndEntityIdOrderByOccurredAtAscIdAsc(entityType, entityId).map { it.toModel() }.toList()

    /**
     * Native SQL, on purpose: "the newest row per entity" is `DISTINCT ON`, which neither derived queries nor
     * Criteria can express (and R2DBC has no JPQL). Read-only, schema-qualified; the entity converter still maps the
     * rows, so the Kotlin types go through the same converters as everywhere else.
     */
    @WithSpan
    override suspend fun latestPerEntity(entityType: String, entityIds: Collection<String>?): List<StoredAuditEvent> {
        val idFilter = if (entityIds == null) "" else "AND entity_id = ANY(:ids)"
        var statement = template.databaseClient.sql(
            """
            SELECT DISTINCT ON (entity_id) *
            FROM auditing.audit_event
            WHERE entity_type = :entityType $idFilter
            ORDER BY entity_id, occurred_at DESC, id DESC
            """.trimIndent(),
        ).bind("entityType", entityType)
        if (entityIds != null) statement = statement.bind("ids", entityIds.toTypedArray())
        return statement.map { row, metadata -> template.converter.read(AuditEventEntity::class.java, row, metadata) }
            .all().asFlow().map { it.toModel() }.toList()
    }

    private fun AuditFilter.toCriteria(): Criteria {
        var criteria = Criteria.empty()
        module?.let { criteria = criteria.and("module").`is`(it) }
        entityType?.let { criteria = criteria.and("entityType").`is`(it) }
        entityId?.let { criteria = criteria.and("entityId").`is`(it) }
        if (eventTypes.isNotEmpty()) criteria = criteria.and("eventType").`in`(eventTypes)
        actorId?.let { criteria = criteria.and("actorId").`is`(it) }
        requestId?.let { criteria = criteria.and("requestId").`is`(it) }
        traceId?.let { criteria = criteria.and("traceId").`is`(it) }
        from?.let { criteria = criteria.and("occurredAt").greaterThanOrEquals(it) }
        to?.let { criteria = criteria.and("occurredAt").lessThan(it) }
        return criteria
    }

    private companion object {
        // The id (UUIDv7) breaks ties between events of the same instant in creation order.
        val NEWEST_FIRST: Sort = Sort.by("occurredAt", "id").descending()
    }
}
