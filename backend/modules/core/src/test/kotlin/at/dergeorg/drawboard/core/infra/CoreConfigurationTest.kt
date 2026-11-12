package at.dergeorg.drawboard.core.infra

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class CoreConfigurationTest {

    @Test
    fun `when the application clock is read then it has no sub-microsecond part`() {
        val clock = CoreConfiguration().clock()

        val instants = List(SAMPLES) { clock.now() }

        assertEquals(
            setOf(0),
            instants.map { it.nanosecondsOfSecond % NANOS_PER_MICRO }.toSet(),
            "PostgreSQL stores microseconds: an instant with nanoseconds would not survive a round trip",
        )
    }

    private companion object {
        const val SAMPLES = 100
        const val NANOS_PER_MICRO = 1_000
    }
}
