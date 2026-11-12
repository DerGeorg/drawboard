package at.dergeorg.drawboard.shared.auditing

import at.dergeorg.drawboard.shared.paging.Page
import at.dergeorg.drawboard.shared.paging.PageQuery

/** Read side of auditing, implemented by the `auditing` module. Usable from api and from any domain module. */
interface AuditLog {

    /** Matching events, newest first. */
    suspend fun find(filter: AuditFilter, page: PageQuery): Page<AuditRecord>

    /** Timeline of one entity, oldest first. */
    suspend fun history(entityType: String, entityId: String): List<AuditRecord>

    /**
     * The newest event per entity - e.g. to derive the status of long-running processes from their events
     * (requested, started, completed). The audit log is the history, not a work queue: claim work in the owning module.
     */
    suspend fun latestPerEntity(entityType: String, entityIds: Collection<String>? = null): List<AuditRecord>
}
