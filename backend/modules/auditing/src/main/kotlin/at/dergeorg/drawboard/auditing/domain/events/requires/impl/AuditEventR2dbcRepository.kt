package at.dergeorg.drawboard.auditing.domain.events.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.repository.Repository
import kotlin.uuid.Uuid

/**
 * Read-only Spring Data repository of audit events: it extends the empty marker [Repository], not CrudRepository,
 * so there is no save, no update and no delete to call. Inserting is R2dbcAuditEventStore's job (template.insert).
 */
internal interface AuditEventR2dbcRepository : Repository<AuditEventEntity, Uuid> {

    /** Timeline of one entity, oldest first; the id (UUIDv7) breaks ties within the same instant. */
    fun findAllByEntityTypeAndEntityIdOrderByOccurredAtAscIdAsc(entityType: String, entityId: String): Flow<AuditEventEntity>
}
