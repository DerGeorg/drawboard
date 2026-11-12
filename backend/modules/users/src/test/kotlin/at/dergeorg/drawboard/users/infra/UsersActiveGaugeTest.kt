package at.dergeorg.drawboard.users.infra

import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.FixedClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.users.domain.InMemoryUserProfileRepository
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.ObjectProvider
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.uuid.Uuid

class UsersActiveGaugeTest {

    @Test
    fun `when the logins are counted then the gauge drawboard_users_active shows 24h, 7d and 30d, and only counts`() = runTest {
        val registry = SimpleMeterRegistry()
        val provider = mockk<ObjectProvider<MeterRegistry>> { every { getObject() } returns registry }
        val profiles = InMemoryUserProfileRepository(
            aUserProfile(TestUsers.ALICE, Uuid.generateV7(), lastLoginAt = FIXED_NOW - 2.hours),
            aUserProfile(TestUsers.BOB, Uuid.generateV7(), lastLoginAt = FIXED_NOW - 3.days),
            aUserProfile(TestUsers.CAROL, Uuid.generateV7(), lastLoginAt = FIXED_NOW - 20.days),
            aUserProfile(TestUsers.CAROL.copy(subject = "dave"), Uuid.generateV7(), lastLoginAt = FIXED_NOW - 90.days),
        )

        UsersActiveGauge(profiles, provider, FixedClock(FIXED_NOW), RecordingAppLogger()).refresh()

        assertEquals(1.0, registry.get("drawboard.users.active").tag("window", "24h").gauge().value(), "last 24 hours")
        assertEquals(2.0, registry.get("drawboard.users.active").tag("window", "7d").gauge().value(), "last 7 days")
        assertEquals(3.0, registry.get("drawboard.users.active").tag("window", "30d").gauge().value(), "last 30 days")
        assertEquals(setOf("window"), registry.meters.flatMap { m -> m.id.tags.map { it.key } }.toSet(), "no user in a label")
    }
}
