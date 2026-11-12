@file:Suppress("ForbiddenImport") // the converters' Java side

package at.dergeorg.drawboard.core.infra.types

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.time.LocalDateTime
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.time.Instant
import kotlin.uuid.Uuid

class R2dbcKotlinTypeConvertersTest {

    @Nested
    inner class Uuids {

        @Test
        fun `when an id is written and read back then it is the same Uuid`() {
            val id = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f")

            val written = UuidToJavaUuidConverter.convert(id)

            assertEquals(UUID.fromString("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f"), written, "the value the driver binds")
            assertEquals(id, JavaUuidToUuidConverter.convert(written), "the value read back")
        }
    }

    @Nested
    inner class Instants {

        @Test
        fun `when an instant is written then the column gets its UTC wall-clock time, whatever the JVM time zone`() {
            val instant = Instant.parse("2026-09-30T08:00:00.123456Z")

            val written = InstantToUtcDateTimeConverter.convert(instant)

            assertEquals(LocalDateTime.parse("2026-09-30T08:00:00.123456"), written, "timestamp (without time zone) in UTC")
            assertEquals(instant, UtcDateTimeToInstantConverter.convert(written), "the instant read back")
        }
    }
}
