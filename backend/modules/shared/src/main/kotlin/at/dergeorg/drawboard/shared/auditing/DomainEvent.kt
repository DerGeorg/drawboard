package at.dergeorg.drawboard.shared.auditing

/**
 * Typed, domain-specific payload of an audit event (the `details` column).
 *
 * Every implementation MUST carry [AuditDetails] with a stable logical name. The name - never the class name -
 * is stored, so classes can be moved or renamed freely. Compatibility rules: a new field needs a default value;
 * a change of meaning gets a new name (`board.task-completed.v2`) and the old class stays.
 */
interface DomainEventDetails

/** Stable logical name of a [DomainEventDetails] type, `<module>.<name>` in kebab case. Never reuse a name. */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class AuditDetails(val type: String)

/** What happened to the entity. Covers CRUD and task-like processes (requested - started - completed/failed). */
enum class AuditAction { CREATED, UPDATED, DELETED, EXECUTED, REQUESTED, STARTED, COMPLETED, FAILED, ACCESSED }

/**
 * Something that happened in a domain and must be audited. Domain modules create events (usually through
 * [DomainEvents]) and hand them to the `AuditTrail` port - they never see how or where events are stored.
 *
 * [before] and [after] are snapshots of the entity (any Jackson-serialisable object); auditing stores only the
 * field-level difference. Who, when, which request and which trace are added by auditing itself.
 */
interface DomainEvent<out D : DomainEventDetails> {
    /** `<module>.<entity-type>.<what-happened>`, e.g. `board.task.completed`. */
    val eventType: String
    val module: String
    val entityType: String
    val entityId: String
    val action: AuditAction
    val before: Any? get() = null
    val after: Any? get() = null
    val details: D? get() = null
}

/** Ready-made [DomainEvent]; most domains never need their own event class. */
data class EntityEvent<out D : DomainEventDetails>(
    override val eventType: String,
    override val module: String,
    override val entityType: String,
    override val entityId: String,
    override val action: AuditAction,
    override val before: Any? = null,
    override val after: Any? = null,
    override val details: D? = null,
) : DomainEvent<D>

/**
 * Event factory of one module, so call sites stay one line:
 * `audit.record(events.updated(TASK, task.id, before = old, after = new))`.
 */
class DomainEvents(private val module: String) {

    fun created(entityType: String, entityId: Any, after: Any, details: DomainEventDetails? = null) =
        of(entityType, entityId, AuditAction.CREATED, "created", details, before = null, after = after)

    fun updated(entityType: String, entityId: Any, before: Any, after: Any, details: DomainEventDetails? = null) =
        of(entityType, entityId, AuditAction.UPDATED, "updated", details, before, after)

    fun deleted(entityType: String, entityId: Any, before: Any, details: DomainEventDetails? = null) =
        of(entityType, entityId, AuditAction.DELETED, "deleted", details, before = before, after = null)

    /** Any other event; [name] becomes the last part of the event type, e.g. `completed`. */
    fun of(
        entityType: String,
        entityId: Any,
        action: AuditAction,
        name: String,
        details: DomainEventDetails? = null,
        before: Any? = null,
        after: Any? = null,
    ): DomainEvent<DomainEventDetails> =
        EntityEvent("$module.$entityType.$name", module, entityType, entityId.toString(), action, before, after, details)
}
