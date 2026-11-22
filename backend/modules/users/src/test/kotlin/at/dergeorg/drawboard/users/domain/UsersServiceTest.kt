package at.dergeorg.drawboard.users.domain

import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.shared.testing.TestUsers.BOB
import at.dergeorg.drawboard.shared.testing.version
import at.dergeorg.drawboard.users.domain.users.model.ColorTheme
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import kotlin.test.assertFailsWith
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.BOB_ID
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aSyncFromLoginCommand
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.uuid.Uuid

class UsersServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()

    private fun serviceWith(repository: InMemoryUserProfileRepository) = UsersService(repository, audit, clock)

    @Nested
    inner class SyncFromLogin {

        @Test
        fun `when syncing given a login seen for the first time then a profile with a v7 id is created and audited`() = runTest {
            val repository = InMemoryUserProfileRepository()

            val profile = serviceWith(repository).syncFromLogin(aSyncFromLoginCommand())

            assertEquals(7, profile.id.version(), "the application assigns a UUIDv7")
            assertEquals(aUserProfile(id = profile.id, firstLoginAt = FIXED_NOW), profile, "created profile")
            assertEquals(listOf(profile), repository.all, "stored profiles")
            val event = audit.events.single()
            assertEquals("users.profile.created", event.eventType, "event type")
            assertEquals(AuditAction.CREATED, event.action, "action")
            assertEquals(profile.id.toString(), event.entityId, "audited entity")
        }

        @Test
        fun `when syncing given a known login then it keeps the id and first login and only moves the last login`() = runTest {
            val stored = aUserProfile()
            val repository = InMemoryUserProfileRepository(stored)
            clock.advanceBy(1.hours)

            val profile = serviceWith(repository).syncFromLogin(aSyncFromLoginCommand())

            assertEquals(stored.id, profile.id, "same user id")
            assertEquals(stored.firstLoginAt, profile.firstLoginAt, "first login stays")
            assertEquals(FIXED_NOW + 1.hours, profile.lastLoginAt, "last login")
            assertEquals(1, profile.version, "version raised by the update")
            assertEquals(listOf(profile), repository.all, "stored profiles")
            assertTrue(audit.events.isEmpty(), "a later login is not audited")
        }

        @Test
        fun `when syncing given changed claims then username, email, and groups are refreshed without an audit event`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile(BOB, id = BOB_ID))
            val changed = aSyncFromLoginCommand(BOB).copy(
                username = "robert",
                email = "robert@example.test",
                groups = listOf("drawboard-users", "drawboard-admins"),
            )

            val profile = serviceWith(repository).syncFromLogin(changed)

            assertEquals("robert", profile.username, "new username")
            assertEquals("robert@example.test", profile.email, "new email")
            assertEquals(listOf("drawboard-users", "drawboard-admins"), profile.groups, "new groups")
            assertTrue(audit.events.isEmpty(), "only the creation is audited")
        }

        @Test
        fun `when syncing given the same subject at another issuer then it is another user`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile())

            val other = serviceWith(repository).syncFromLogin(aSyncFromLoginCommand().copy(issuer = "https://other.example.test"))

            assertNotEquals(aUserProfile().id, other.id, "unique key is issuer + subject")
            assertEquals(2, repository.all.size, "two profiles")
        }

        @Test
        fun `when syncing given a concurrent update of the same user then the winner's profile is returned`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile())
            repository.failNextUpdate = true

            val profile = serviceWith(repository).syncFromLogin(aSyncFromLoginCommand())

            assertEquals(aUserProfile(), profile, "the stored profile, untouched by the lost update")
        }
    }

    @Nested
    inner class ChangeTheme {

        @Test
        fun `when syncing given a login seen for the first time then the theme is SYSTEM`() = runTest {
            val profile = serviceWith(InMemoryUserProfileRepository()).syncFromLogin(aSyncFromLoginCommand())

            assertEquals(ColorTheme.SYSTEM, profile.theme, "new users follow the operating system")
        }

        @Test
        fun `when changing the theme then it is stored without an audit event`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile())

            val profile = serviceWith(repository).changeTheme(aUserProfile().id, ColorTheme.DARK)

            assertEquals(ColorTheme.DARK, profile.theme, "returned theme")
            assertEquals(1, profile.version, "version raised by the update")
            assertEquals(listOf(profile), repository.all, "stored profiles")
            assertTrue(audit.events.isEmpty(), "a display setting is not audited")
        }

        @Test
        fun `when changing the theme given the stored one then nothing is written`() = runTest {
            val stored = aUserProfile(theme = ColorTheme.LIGHT)
            val repository = InMemoryUserProfileRepository(stored)

            val profile = serviceWith(repository).changeTheme(stored.id, ColorTheme.LIGHT)

            assertEquals(stored, profile, "unchanged profile, same version")
        }

        @Test
        fun `when syncing a login after the theme was changed then the theme stays`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile(theme = ColorTheme.DARK))

            val profile = serviceWith(repository).syncFromLogin(aSyncFromLoginCommand())

            assertEquals(ColorTheme.DARK, profile.theme, "a claims refresh never resets the theme")
        }

        @Test
        fun `when a concurrent update wins once then the change is applied on top of it`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile())
            repository.failNextUpdate = true

            val profile = serviceWith(repository).changeTheme(aUserProfile().id, ColorTheme.DARK)

            assertEquals(ColorTheme.DARK, profile.theme, "retried after the lost update")
        }

        @Test
        fun `when concurrent updates keep winning then CONFLICT`() = runTest {
            val repository = InMemoryUserProfileRepository(aUserProfile())
            repository.failAllUpdates = true

            val failure = assertFailsWith<DomainException>("three lost updates in a row") {
                serviceWith(repository).changeTheme(aUserProfile().id, ColorTheme.DARK)
            }

            assertEquals(ErrorCode.CONFLICT, failure.errorCode, "error code")
        }
    }

    @Nested
    inner class Lookups {

        @Test
        fun `when finding by login given a known login then the profile is returned`() = runTest {
            val stored = aUserProfile()

            val found = serviceWith(InMemoryUserProfileRepository(stored)).findByLogin(ALICE.issuer, ALICE.subject)

            assertEquals(stored, found, "profile of the login")
        }

        @Test
        fun `when finding by login given an unknown login then null and nothing is written`() = runTest {
            val repository = InMemoryUserProfileRepository()

            val found = serviceWith(repository).findByLogin(ALICE.issuer, ALICE.subject)

            assertNull(found, "no profile for a login that never happened")
            assertTrue(repository.all.isEmpty() && audit.events.isEmpty(), "a lookup does not create anything")
        }

        @Test
        fun `when finding by id given a known and an unknown id then the profile and null`() = runTest {
            val stored = aUserProfile()
            val service = serviceWith(InMemoryUserProfileRepository(stored))

            assertEquals(stored, service.findById(stored.id), "known id")
            assertNull(service.findById(Uuid.random()), "unknown id")
        }
    }
}
