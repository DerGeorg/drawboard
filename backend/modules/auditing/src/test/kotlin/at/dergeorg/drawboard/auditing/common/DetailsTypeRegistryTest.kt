package at.dergeorg.drawboard.auditing.common

import at.dergeorg.drawboard.auditing.common.samples.valid.StockAdjusted
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DetailsTypeRegistryTest {

    private val samples = "at.dergeorg.drawboard.auditing.common.samples"

    @Nested
    inner class Scan {

        @Test
        fun `when scanning a package then every annotated details class is registered under its logical name`() {
            val registry = DetailsTypeRegistry(listOf("$samples.valid"))

            assertEquals(setOf("sample.stock-adjusted", "sample.task-completed"), registry.types.keys, "registered logical names")
            assertEquals("sample.stock-adjusted", registry.nameOf(StockAdjusted::class.java), "name of a registered class")
        }
    }

    @Nested
    inner class FailFast {

        @Test
        fun `when two classes use the same name then the registry refuses to start`() {
            val failure = assertFailsWith<IllegalStateException>("duplicate logical names must stop the application") {
                DetailsTypeRegistry(listOf("$samples.duplicate"))
            }

            assertContains(failure.message.orEmpty(), "sample.same-name", message = "the message names the duplicate")
        }

        @Test
        fun `when an annotated class does not implement DomainEventDetails then the registry refuses to start`() {
            val failure = assertFailsWith<IllegalStateException>("@AuditDetails on a class that is no DomainEventDetails") {
                DetailsTypeRegistry(listOf("$samples.notdetails"))
            }

            assertContains(failure.message.orEmpty(), "does not implement DomainEventDetails", message = "the message names the problem")
        }

        @Test
        fun `when a name has no module prefix then the registry refuses to start`() {
            val failure = assertFailsWith<IllegalStateException>("names must be <module>.<name> in kebab case") {
                DetailsTypeRegistry(listOf("$samples.badname"))
            }

            assertContains(failure.message.orEmpty(), "NoModulePrefix", message = "the message names the bad name")
        }
    }
}
