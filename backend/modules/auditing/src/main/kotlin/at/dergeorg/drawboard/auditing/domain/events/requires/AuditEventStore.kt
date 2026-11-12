package at.dergeorg.drawboard.auditing.domain.events.requires

import at.dergeorg.drawboard.auditing.domain.events.model.StoredAuditEvent
import at.dergeorg.drawboard.shared.auditing.AuditFilter
import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery

/** Append-only store of audit events. There is deliberately no update and no delete. */
internal interface AuditEventStore {

    suspend fun insert(event: StoredAuditEvent)

    /** Newest first. */
    suspend fun find(filter: AuditFilter, page: PageQuery): Page<StoredAuditEvent>

    /** Oldest first. */
    suspend fun history(entityType: String, entityId: String): List<StoredAuditEvent>

    suspend fun latestPerEntity(entityType: String, entityIds: Collection<String>?): List<StoredAuditEvent>
}
