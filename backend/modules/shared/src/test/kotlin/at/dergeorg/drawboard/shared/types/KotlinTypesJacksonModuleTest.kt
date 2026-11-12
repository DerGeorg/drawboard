package at.dergeorg.drawboard.shared.types

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import tools.jackson.databind.exc.InvalidFormatException
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule
import tools.jackson.module.kotlin.readValue
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fixes the JSON format of the Kotlin types - the same mapper setup as Boot's (Kotlin module + every JacksonModule bean). */
class KotlinTypesJacksonModuleTest {

    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).addModule(KotlinTypesJacksonModule()).build()

    private val sample = Sample(
        id = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f"),
        at = Instant.parse("2026-09-30T08:00:00.123456Z"),
        openFor = 2.hours,
        optionalId = null,
    )

    @Nested
    inner class Writing {

        @Test
        fun `when writing then Uuid Instant and Duration are ISO strings`() {
            assertEquals(
                """{"id":"0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f","at":"2026-09-30T08:00:00.123456Z","openFor":"PT2H","optionalId":null}""",
                mapper.writeValueAsString(sample),
                "JSON of the Kotlin types",
            )
        }

        @Test
        fun `when writing a whole-second instant then it has no fraction`() {
            assertEquals("\"2026-09-30T08:00:00Z\"", mapper.writeValueAsString(Instant.parse("2026-09-30T08:00:00Z")), "instant in UTC")
        }
    }

    @Nested
    inner class Reading {

        @Test
        fun `when reading what was written then the values are equal`() {
            assertEquals(sample, mapper.readValue<Sample>(mapper.writeValueAsString(sample)), "round trip")
        }

        @Test
        fun `when reading an instant with an offset then it is the same point in time`() {
            assertEquals(
                Instant.parse("2026-09-30T08:00:00Z"),
                mapper.readValue<Instant>("\"2026-09-30T10:00:00+02:00\""),
                "offsets are accepted on input",
            )
        }

        @Test
        fun `when reading a malformed id then Jackson rejects the input instead of failing inside`() {
            assertFailsWith<InvalidFormatException>("a malformed id is bad input (400), not a server error") {
                mapper.readValue<Sample>("""{"id":"not-a-uuid","at":"2026-09-30T08:00:00Z","openFor":"PT1S"}""")
            }
        }
    }

    data class Sample(val id: Uuid, val at: Instant, val openFor: Duration, val optionalId: Uuid?)
}
