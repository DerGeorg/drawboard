package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.logging.AppLogger
import org.slf4j.Logger
import org.slf4j.spi.LoggingEventBuilder

/**
 * [AppLogger] on top of SLF4J (Logback): the fields become key-value pairs of the logging event, which Boot's ECS
 * format writes as JSON fields of their own (`"error":{"code":"..."}` for `error.code`). The only place besides the
 * MDC bridge that uses org.slf4j (ArchUnit).
 */
internal class Slf4jAppLogger(private val delegate: Logger) : AppLogger {

    override fun debug(message: String, fields: Map<String, Any?>) = log(delegate.atDebug(), message, null, fields)

    override fun info(message: String, fields: Map<String, Any?>) = log(delegate.atInfo(), message, null, fields)

    override fun warn(message: String, fields: Map<String, Any?>) = log(delegate.atWarn(), message, null, fields)

    override fun error(message: String, cause: Throwable?, fields: Map<String, Any?>) =
        log(delegate.atError(), message, cause, fields)

    private fun log(event: LoggingEventBuilder, message: String, cause: Throwable?, fields: Map<String, Any?>) {
        // atX() returns a no-op builder when the level is off - nothing below costs anything then.
        // A field without value is left out instead of being written as null.
        fields.forEach { (key, value) -> if (value != null) event.addKeyValue(key, value) }
        cause?.let(event::setCause)
        event.log(message)
    }
}
