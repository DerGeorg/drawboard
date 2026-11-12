package at.dergeorg.drawboard.shared.testing

import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvent
import at.dergeorg.drawboard.shared.context.Actor
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.context.CurrentGuestProvider
import at.dergeorg.drawboard.shared.context.CurrentUser
import at.dergeorg.drawboard.shared.context.CurrentUserProvider
import at.dergeorg.drawboard.shared.context.RequestContext
import at.dergeorg.drawboard.shared.context.RequestContextProvider
import at.dergeorg.drawboard.shared.logging.AppLogger
import kotlin.uuid.Uuid

/** Fake of the [AuditTrail] port for domain unit tests: keeps the recorded events in memory, in order. */
class RecordingAuditTrail : AuditTrail {
    private val recorded = mutableListOf<DomainEvent<*>>()

    val events: List<DomainEvent<*>> get() = recorded.toList()

    override suspend fun record(event: DomainEvent<*>): Uuid {
        recorded += event
        return Uuid.generateV7()
    }
}

/** Fake of the [CurrentUserProvider] port; `null` = anonymous. */
class FixedCurrentUserProvider(var user: CurrentUser? = TestUsers.ALICE) : CurrentUserProvider {
    override suspend fun currentUserOrNull(): CurrentUser? = user
}

/** Fake of the [RequestContextProvider] port with fixed ids. */
class FixedRequestContextProvider(
    var context: RequestContext = RequestContext(
        actor = Actor.user(TestUsers.ALICE.subject),
        requestId = "test-request-0001",
        traceId = "4bf92f3577b34da6a3ce929d0e0e4736",
    ),
) : RequestContextProvider {
    override suspend fun current(): RequestContext = context
}

/** Fake of the [AppLogger] port: keeps every entry in memory, so a test can check what was logged. */
class RecordingAppLogger : AppLogger {
    private val recorded = mutableListOf<LogEntry>()

    val entries: List<LogEntry> get() = recorded.toList()

    override fun debug(message: String, fields: Map<String, Any?>) = record(LogLevel.DEBUG, message, null, fields)

    override fun info(message: String, fields: Map<String, Any?>) = record(LogLevel.INFO, message, null, fields)

    override fun warn(message: String, fields: Map<String, Any?>) = record(LogLevel.WARN, message, null, fields)

    override fun error(message: String, cause: Throwable?, fields: Map<String, Any?>) =
        record(LogLevel.ERROR, message, cause, fields)

    private fun record(level: LogLevel, message: String, cause: Throwable?, fields: Map<String, Any?>) {
        // like the real logger: a field without value is left out
        recorded += LogEntry(level, message, cause, fields.filterValues { it != null })
    }

    enum class LogLevel { DEBUG, INFO, WARN, ERROR }

    data class LogEntry(val level: LogLevel, val message: String, val cause: Throwable?, val fields: Map<String, Any?>)
}

/** Fake of the [CurrentGuestProvider] port; `null` = nobody is a guest. */
class FixedCurrentGuestProvider(var guest: CurrentGuest? = null) : CurrentGuestProvider {
    override suspend fun currentGuestOrNull(): CurrentGuest? = guest
}
