package at.dergeorg.drawboard.shared.types

import org.springframework.core.convert.converter.Converter
import kotlin.time.Instant
import kotlin.uuid.Uuid

// Path and query parameters of the generated contract interfaces are kotlin.uuid.Uuid / kotlin.time.Instant. Spring
// Web knows neither; core registers these as beans and Boot adds them to the WebFlux conversion service. A value that
// does not parse fails the conversion -> 400 MALFORMED_REQUEST. In shared, so that api's slice tests register them too.

/** `GET /api/boards/{boardId}` -> [Uuid]. */
class StringToUuidConverter : Converter<String, Uuid> {
    override fun convert(source: String): Uuid = Uuid.parse(source.trim())
}

/** `?from=2026-09-30T08:00:00Z` -> [Instant] (ISO-8601). */
class StringToInstantConverter : Converter<String, Instant> {
    override fun convert(source: String): Instant = Instant.parse(source.trim())
}
