package at.dergeorg.drawboard.shared.auditing

import kotlin.uuid.Uuid

/**
 * Write side of auditing - required by every domain module, implemented by the `auditing` module.
 *
 * [record] joins the caller's transaction: if the business change rolls back, the audit event rolls back too; if
 * the audit insert fails, the business change fails. Nothing is lost, nothing is recorded that did not happen.
 * Call it inside the @Transactional use case, right after the change.
 */
interface AuditTrail {
    suspend fun record(event: DomainEvent<*>): Uuid
}
