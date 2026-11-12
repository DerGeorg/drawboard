package at.dergeorg.drawboard.api.domain.users

import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import io.mockk.coVerify
import kotlin.time.Duration.Companion.seconds
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FixedCurrentUserProvider
import at.dergeorg.drawboard.shared.testing.TestUsers
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aSyncFromLoginCommand
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.aUserProfile
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class UsersApiServiceTest {

    private val currentUsers = FixedCurrentUserProvider()
    private val profiles = mockk<UserProfilesUseCase>()
    private val clock = MutableClock()
    private fun serviceWith(properties: DrawboardProperties = DrawboardProperties("https://draw.example.org")) =
        UsersApiService(SignedInUsers(currentUsers, profiles), profiles, properties, clock)

    private val service = serviceWith()

    @Nested
    inner class GetCurrentUser {

        @Test
        fun `when a user is signed in then the token's claims are synced as a login and the stored profile is returned`() = runTest {
            val stored = aUserProfile(TestUsers.ALICE)
            coEvery { profiles.syncFromLogin(aSyncFromLoginCommand(TestUsers.ALICE)) } returns stored

            val user = service.getCurrentUser()

            assertEquals(stored.id, user.id, "the application's own user id, not the subject")
            assertEquals("alice", user.username, "username from the profile")
            assertEquals(TestUsers.ALICE.email, user.email, "email from the profile")
            assertTrue(user.admin, "alice is in the admin group")
        }

        @Test
        fun `when a user without a name, email and groups signs in then those stay empty and admin is false`() = runTest {
            currentUsers.user = TestUsers.CAROL
            coEvery { profiles.syncFromLogin(aSyncFromLoginCommand(TestUsers.CAROL)) } returns aUserProfile(TestUsers.CAROL)

            val user = service.getCurrentUser()

            assertEquals(null to null, user.displayName to user.email, "optional claims stay null")
            assertEquals(false, user.admin, "no admin group")
        }

        @Test
        fun `when nobody is signed in then UNAUTHORIZED is thrown and no profile is written`() = runTest {
            currentUsers.user = null

            val failure = assertFailsWith<DomainException>("an anonymous call must be rejected") { service.getCurrentUser() }

            assertEquals(ErrorCode.UNAUTHORIZED, failure.errorCode, "error code without a user")
            coVerify(exactly = 0) { profiles.syncFromLogin(any()) }
        }
    }

    @Nested
    inner class SearchUsers {

        private val alice = aUserProfile(TestUsers.ALICE)
        private val bob = aUserProfile(TestUsers.BOB)

        init {
            coEvery { profiles.findByLogin(TestUsers.ALICE.issuer, TestUsers.ALICE.subject) } returns alice
        }

        @Test
        fun `when searching then hits come with id, username and display name - and never an email`() = runTest {
            coEvery { profiles.search("bo", 20) } returns listOf(bob)

            val result = service.searchUsers(" bo ")

            assertEquals(listOf(bob.id), result.items.map { it.id }, "hit")
            assertEquals(listOf("bob"), result.items.map { it.username }, "username")
            assertEquals(listOf(bob.displayName), result.items.map { it.displayName }, "display name")
        }

        @Test
        fun `when the term has fewer than two characters then VALIDATION_FAILED and no search`() = runTest {
            assertFailsWith<ValidationFailedException>("one character") { service.searchUsers(" b ") }

            coVerify(exactly = 0) { profiles.search(any(), any()) }
        }

        @Test
        fun `when searching 31 times in a minute then TOO_MANY_REQUESTS, and again after the minute`() = runTest {
            coEvery { profiles.search(any(), any()) } returns emptyList()
            repeat(30) { service.searchUsers("bo") }

            val failure = assertFailsWith<RateLimitedException>("31st search") { service.searchUsers("bo") }
            clock.advanceBy(61.seconds)
            service.searchUsers("bo")

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, failure.errorCode, "error code")
        }

        @Test
        fun `when user search is off then the list is always empty and the users module is not asked`() = runTest {
            val off = serviceWith(DrawboardProperties("https://draw.example.org", userSearch = "off"))

            assertEquals(emptyList(), off.searchUsers("bo").items, "off = empty")
            coVerify(exactly = 0) { profiles.search(any(), any()) }
        }

        @Test
        fun `when DRAWBOARD_USER_SEARCH is neither all nor off then the properties refuse to start`() {
            assertFailsWith<IllegalArgumentException>("typo") { DrawboardProperties("https://draw.example.org", userSearch = "some") }
        }
    }
}
