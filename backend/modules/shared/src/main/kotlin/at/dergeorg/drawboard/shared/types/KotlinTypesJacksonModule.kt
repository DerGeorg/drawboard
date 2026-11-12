package at.dergeorg.drawboard.shared.types

import tools.jackson.core.JsonGenerator
import tools.jackson.core.JsonParser
import tools.jackson.databind.DeserializationContext
import tools.jackson.databind.SerializationContext
import tools.jackson.databind.deser.std.StdScalarDeserializer
import tools.jackson.databind.module.SimpleModule
import tools.jackson.databind.ser.std.StdScalarSerializer
import kotlin.time.Duration
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * JSON for the Kotlin types the whole application uses - jackson-module-kotlin 3.1 knows none of them:
 *  - [Uuid] as the canonical string `0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f`
 *  - [Instant] as ISO-8601 in UTC `2026-09-30T08:00:00Z` (`2026-09-30T08:00:00.123456Z` with fractions)
 *  - [Duration] as ISO-8601 `PT2H` (without this module a value class is written as its internal Long)
 *
 * Unreadable values fail like every other bad input (Jackson's InvalidFormatException -> 400), never with a 500.
 * Lives in shared (like WithSpanAspect) so that core registers it as a bean and slice tests of api and unit tests of
 * auditing use the very same module; it needs no java.time / java.util.UUID.
 */
class KotlinTypesJacksonModule : SimpleModule(NAME) {

    init {
        addSerializer(Uuid::class.java, ToStringSerializer(Uuid::class.java))
        addDeserializer(Uuid::class.java, ParsingDeserializer(Uuid::class.java, "not a UUID", Uuid::parse))
        addSerializer(Instant::class.java, ToStringSerializer(Instant::class.java))
        addDeserializer(Instant::class.java, ParsingDeserializer(Instant::class.java, "not an ISO-8601 instant", Instant::parse))
        addSerializer(Duration::class.java, DurationSerializer())
        addDeserializer(
            Duration::class.java,
            ParsingDeserializer(Duration::class.java, "not an ISO-8601 duration", Duration::parseIsoString),
        )
    }

    private class ToStringSerializer<T : Any>(type: Class<T>) : StdScalarSerializer<T>(type) {
        override fun serialize(value: T, generator: JsonGenerator, context: SerializationContext) {
            generator.writeString(value.toString())
        }
    }

    private class DurationSerializer : StdScalarSerializer<Duration>(Duration::class.java) {
        override fun serialize(value: Duration, generator: JsonGenerator, context: SerializationContext) {
            generator.writeString(value.toIsoString())
        }
    }

    private class ParsingDeserializer<T : Any>(
        private val type: Class<T>,
        private val problem: String,
        private val parse: (String) -> T,
    ) : StdScalarDeserializer<T>(type) {
        override fun deserialize(parser: JsonParser, context: DeserializationContext): T {
            val text = parser.valueAsString ?: return type.cast(context.handleUnexpectedToken(type, parser))
            return runCatching { parse(text.trim()) }
                .getOrElse { type.cast(context.handleWeirdStringValue(type, text, problem)) }
        }
    }

    private companion object {
        const val NAME = "kotlin-types"
    }
}
