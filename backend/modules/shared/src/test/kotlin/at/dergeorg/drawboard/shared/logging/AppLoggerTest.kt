package at.dergeorg.drawboard.shared.logging

import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger.LogLevel
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

/** The two ways to pass fields - pairs at the call site, a map from a helper - end up as the same log entry. */
class AppLoggerTest {

    private val log = RecordingAppLogger()

    @Nested
    inner class Fields {

        @Test
        fun `when fields are passed as pairs then they arrive like a map`() {
            log.info("schema migrated", "db.namespace" to "board", "flyway.migrations_executed" to 2)
            log.info("schema migrated", mapOf("db.namespace" to "board", "flyway.migrations_executed" to 2))

            val (pairs, map) = log.entries
            assertEquals(map, pairs, "pairs and map give the same entry")
            assertEquals(mapOf("db.namespace" to "board", "flyway.migrations_executed" to 2), pairs.fields, "fields of the entry")
        }

        @Test
        fun `when a field has no value then it is left out`() {
            log.warn("request rejected", "error.code" to "FORBIDDEN", "error.message" to null)

            assertEquals(mapOf("error.code" to "FORBIDDEN"), log.entries.single().fields, "null field left out")
        }
    }

    @Nested
    inner class Levels {

        @Test
        fun `when logging on every level then each entry keeps its level`() {
            val failure = IllegalStateException("boom")

            log.debug("d")
            log.info("i")
            log.warn("w")
            log.error("e", failure)

            assertEquals(listOf(LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR), log.entries.map { it.level }, "levels")
            assertSame(failure, log.entries.last().cause, "error keeps the cause for the stack trace")
        }
    }
}
