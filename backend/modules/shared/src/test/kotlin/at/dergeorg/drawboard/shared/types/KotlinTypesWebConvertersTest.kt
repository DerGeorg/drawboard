package at.dergeorg.drawboard.shared.types

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Instant
import kotlin.uuid.Uuid

class KotlinTypesWebConvertersTest {

    @Test
    fun `when a path parameter is a UUID then it becomes a Uuid`() {
        assertEquals(
            Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f"),
            StringToUuidConverter().convert("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f"),
            "converted path parameter",
        )
    }

    @Test
    fun `when a path parameter is no UUID then the conversion fails`() {
        assertFailsWith<IllegalArgumentException>("Spring turns the failed conversion into 400") {
            StringToUuidConverter().convert("not-a-uuid")
        }
    }

    @Test
    fun `when a query parameter is an ISO instant then it becomes an Instant`() {
        assertEquals(
            Instant.parse("2026-09-30T08:00:00Z"),
            StringToInstantConverter().convert("2026-09-30T08:00:00Z"),
            "converted query parameter",
        )
    }
}
