package at.dergeorg.drawboard.auditing.common

import at.dergeorg.drawboard.auditing.common.samples.valid.StockAdjusted
import at.dergeorg.drawboard.auditing.common.samples.valid.TaskCompleted
import at.dergeorg.drawboard.shared.auditing.FieldChange
import at.dergeorg.drawboard.shared.auditing.UnknownDetails
import at.dergeorg.drawboard.shared.types.KotlinTypesJacksonModule
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.time.Duration.Companion.hours

class AuditJsonTest {

    private val json = AuditJson(
        bootMapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).addModule(KotlinTypesJacksonModule()).build(),
        registry = DetailsTypeRegistry(listOf("at.dergeorg.drawboard.auditing.common.samples.valid")),
    )

    @Nested
    inner class Details {

        @Test
        fun `when details are written then the logical name is stored instead of the class name`() {
            val written = json.writeDetails(StockAdjusted(delta = -3, reason = "SALE"))

            assertContains(written, "\"@type\":\"sample.stock-adjusted\"", message = "stored JSON of the details")
            assertFalse("StockAdjusted" in written, "no class names in the database: $written")
        }

        @Test
        fun `when details are written and read back then the typed object is equal`() {
            val details = TaskCompleted(openFor = 2.hours)

            assertEquals(details, json.readDetails(json.writeDetails(details)), "round trip of typed details incl. time values")
        }

        @Test
        fun `when a stored row has a field the class no longer has then it is ignored`() {
            val stored = """{"@type":"sample.stock-adjusted","delta":1,"reason":"COUNT","removedField":"x"}"""

            assertEquals(
                StockAdjusted(delta = 1, reason = "COUNT"),
                json.readDetails(stored),
                "old rows must stay readable after a field was removed",
            )
        }

        @Test
        fun `when a stored type is not registered then UnknownDetails with the raw JSON is returned`() {
            val stored = """{"@type":"sample.from-the-future","value":1}"""

            assertEquals(UnknownDetails("sample.from-the-future", stored), json.readDetails(stored), "unknown types must not fail the read")
        }
    }

    @Nested
    inner class Diff {

        @Test
        fun `when an entity is created then every field is a change from null`() {
            val changes = json.diff(before = null, after = Snapshot(title = "Write tests", done = false))

            assertEquals(
                listOf(FieldChange("done", null, false), FieldChange("title", null, "Write tests")),
                changes,
                "changes of a created entity",
            )
        }

        @Test
        fun `when one field changed then only that field is listed`() {
            val changes = json.diff(Snapshot("Write tests", done = false), Snapshot("Write tests", done = true))

            assertEquals(listOf(FieldChange("done", false, true)), changes, "changes of an update")
        }

        @Test
        fun `when a nested object changed then the path is dotted`() {
            val changes = json.diff(Wrapper(Snapshot("a", false)), Wrapper(Snapshot("b", false)))

            assertEquals(listOf(FieldChange("inner.title", "a", "b")), changes, "path of a nested change")
        }

        @Test
        fun `when a field looks like a secret then its values are redacted`() {
            val changes = json.diff(Credentials(apiToken = "old"), Credentials(apiToken = "new"))

            assertEquals(listOf(FieldChange("apiToken", "***", "***")), changes, "secrets must never reach the audit log")
        }
    }

    data class Snapshot(val title: String, val done: Boolean)

    data class Wrapper(val inner: Snapshot)

    data class Credentials(val apiToken: String)
}
