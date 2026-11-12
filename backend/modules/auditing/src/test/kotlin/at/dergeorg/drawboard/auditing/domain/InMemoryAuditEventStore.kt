package at.dergeorg.drawboard.auditing.domain

import at.dergeorg.drawboard.auditing.domain.events.model.StoredAuditEvent
import at.dergeorg.drawboard.auditing.domain.events.requires.AuditEventStore
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery

/** Fake of the internal [AuditEventStore] port (lives in src/test: internal types are invisible to other modules anyway). */
internal class InMemoryAuditEventStore : AuditEventStore {
    val events = mutableListOf<StoredAuditEvent>()

    override suspend fun insert(event: StoredAuditEvent) {
        events += event
    }

    override suspend fun find(filter: AuditFilter, page: PageQuery): Page<StoredAuditEvent> {
        val matching = events.filter { event -> filter.entityId == null || event.entityId == filter.entityId }
            .sortedByDescending { it.occurredAt }
        return Page(matching.drop(page.offset.toInt()).take(page.size), page, matching.size.toLong())
    }

    override suspend fun history(entityType: String, entityId: String): List<StoredAuditEvent> =
        events.filter { it.entityType == entityType && it.entityId == entityId }.sortedBy { it.occurredAt }

    override suspend fun latestPerEntity(entityType: String, entityIds: Collection<String>?): List<StoredAuditEvent> =
        events.filter { it.entityType == entityType && (entityIds == null || it.entityId in entityIds) }
            .groupBy { it.entityId }.values.map { perEntity -> perEntity.maxBy { it.occurredAt } }
}
