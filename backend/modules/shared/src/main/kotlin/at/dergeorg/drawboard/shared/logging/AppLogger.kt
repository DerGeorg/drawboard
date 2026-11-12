package at.dergeorg.drawboard.shared.logging

/**
 * The only way application code writes logs - a port, implemented in core (`Slf4jAppLogger`). Injected per class
 * through the constructor (`private val log: AppLogger`), so modules never touch a logging library.
 *
 * The usual levels, nothing else: [debug], [info], [warn], [error]. The message is constant text; variable data goes
 * into fields (ECS-style dotted keys such as `error.code`, `url.path`, `<module>.<thing>.<field>`), so Loki can
 * filter on them and no personal data ends up in a sentence. A field whose value is null is left out. Request id,
 * trace id and span id are added from the MDC by the log format - never pass them here.
 *
 * Fields come as pairs (`log.info("schema migrated", "db.namespace" to schema)`) or, when a helper builds the
 * fields shared by several log lines, as a map (`log.warn("request rejected", exchange.problemFields(...))`).
 */
interface AppLogger {
    fun debug(message: String, fields: Map<String, Any?>)

    fun info(message: String, fields: Map<String, Any?>)

    fun warn(message: String, fields: Map<String, Any?>)

    /** [cause] adds the stack trace; null when there is no exception. */
    fun error(message: String, cause: Throwable?, fields: Map<String, Any?>)

    fun debug(message: String, vararg fields: Pair<String, Any?>) = debug(message, fields.toMap())

    fun info(message: String, vararg fields: Pair<String, Any?>) = info(message, fields.toMap())

    fun warn(message: String, vararg fields: Pair<String, Any?>) = warn(message, fields.toMap())

    fun error(message: String, cause: Throwable?, vararg fields: Pair<String, Any?>) = error(message, cause, fields.toMap())
}
