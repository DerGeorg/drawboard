// The R2DBC driver speaks java.util.UUID and java.time.LocalDateTime: this is one of the few places allowed to touch
// them (detekt ForbiddenImport, ArchUnit) - everything else uses kotlin.uuid / kotlin.time.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.core.infra.types

import org.springframework.core.convert.converter.Converter
import org.springframework.data.convert.ReadingConverter
import org.springframework.data.convert.WritingConverter
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.time.Instant
import kotlin.time.toJavaInstant
import kotlin.time.toKotlinInstant
import kotlin.uuid.Uuid
import kotlin.uuid.toJavaUuid
import kotlin.uuid.toKotlinUuid

/*
 * Kotlin types <-> what r2dbc-postgresql binds and returns. Columns are `uuid` and `timestamp` (WITHOUT time zone,
 * values in UTC): the application is the only one that writes them and always means UTC, so no session time zone is
 * involved anywhere. All four live in ONE R2dbcCustomConversions bean (KotlinTypesConfiguration); with them Spring
 * Data treats Uuid and Instant as simple types - in entities, ids, derived queries and Criteria alike.
 */

@WritingConverter
internal object UuidToJavaUuidConverter : Converter<Uuid, UUID> {
    override fun convert(source: Uuid): UUID = source.toJavaUuid()
}

@ReadingConverter
internal object JavaUuidToUuidConverter : Converter<UUID, Uuid> {
    override fun convert(source: UUID): Uuid = source.toKotlinUuid()
}

/** `timestamp` holds UTC: the instant becomes the UTC wall-clock time. */
@WritingConverter
internal object InstantToUtcDateTimeConverter : Converter<Instant, LocalDateTime> {
    override fun convert(source: Instant): LocalDateTime = LocalDateTime.ofInstant(source.toJavaInstant(), ZoneOffset.UTC)
}

@ReadingConverter
internal object UtcDateTimeToInstantConverter : Converter<LocalDateTime, Instant> {
    override fun convert(source: LocalDateTime): Instant = source.toInstant(ZoneOffset.UTC).toKotlinInstant()
}
