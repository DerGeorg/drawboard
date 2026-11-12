package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.shared.testing.TestUsers.BOB
import at.dergeorg.drawboard.shared.testing.TestUsers.CAROL
import at.dergeorg.drawboard.shared.testing.version
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid
import at.dergeorg.drawboard.shared.context.CurrentUser as TokenUser

/** GET /api/users/me through the whole stack: token -> users module (profile in PostgreSQL) -> audit event. */
@IntegrationTest
class UsersApiIntegrationTest(
    private val client: WebTestClient,
    private val auditLog: AuditLog,
    private val profiles: UserProfilesUseCase,
) {

    /** A user nobody has seen before - profiles are per login, so every test gets its own. */
    private fun newUser(base: TokenUser = BOB) = base.copy(subject = "sub-${Uuid.random()}", username = "user-${Uuid.random()}")

    private fun getMe(user: TokenUser) =
        client.signedInAs(user).get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult()

    @Nested
    inner class GetCurrentUser {

        @Test
        fun `when GET users me given a new user then 200 with our own v7 id and the profile is created and audited once`() = runTest {
            val user = newUser()

            val result = getMe(user)

            assertEquals(HttpStatus.OK, result.status, "status of GET /api/users/me")
            val me = assertNotNull(result.responseBody, "the signed-in user")
            assertEquals(7, me.id.version(), "our own UUIDv7, assigned at the first login")
            assertEquals(user.username to user.email, me.username to me.email, "claims of the token")
            assertEquals(user.displayName, me.displayName, "display name of the token")
            assertEquals(false, me.admin, "bob's groups do not contain the admin group")
            assertEquals(
                listOf("users.profile.created"),
                auditLog.history("profile", me.id.toString()).map { it.eventType },
                "audit timeline of the profile",
            )
        }

        @Test
        fun `when GET users me given a user in the admin group then admin is true`() {
            val me = getMe(newUser(ALICE)).responseBody

            assertEquals(true, me?.admin, "the groups claim contains the configured admin group")
        }

        @Test
        fun `when GET users me given a minimal token then 200 and the optional fields are null`() {
            val me = getMe(newUser(CAROL)).responseBody

            assertEquals(null to null, me?.displayName to me?.email, "no name and no email claim")
        }

        @Test
        fun `when GET users me given the same login again then the id stays, the last login moves and nothing more is audited`() = runTest {
            val user = newUser()
            val first = assertNotNull(getMe(user).responseBody, "first call")
            val before = assertNotNull(profiles.findById(first.id), "stored profile after the first call")

            val again = assertNotNull(getMe(user).responseBody, "second call")

            assertEquals(first.id, again.id, "same user id for the same login")
            val after = assertNotNull(profiles.findById(first.id), "stored profile after the second call")
            assertTrue(after.lastLoginAt >= before.lastLoginAt && after.version > before.version, "login recorded: $before -> $after")
            assertEquals(before.firstLoginAt, after.firstLoginAt, "first login stays")
            assertEquals(1, auditLog.history("profile", first.id.toString()).size, "only the creation is audited")
        }

        @Test
        fun `when GET users me given changed claims then the profile follows the token`() = runTest {
            val user = newUser()
            val first = assertNotNull(getMe(user).responseBody, "first call")

            val changed = assertNotNull(getMe(user.copy(email = "new@example.test", username = "renamed")).responseBody, "changed claims")

            assertEquals(first.id, changed.id, "the user keeps the id when username or email change at the provider")
            assertEquals("new@example.test" to "renamed", changed.email to changed.username, "refreshed claims")
        }

        @Test
        fun `when GET users me given the same subject at another issuer then it is another user`() {
            val user = newUser()
            val first = assertNotNull(getMe(user).responseBody, "first issuer")

            val other = assertNotNull(getMe(user.copy(issuer = "https://other-idp.example.test")).responseBody, "second issuer")

            assertTrue(first.id != other.id, "the login key is issuer + subject")
        }

        @Test
        fun `when GET users me given no token then 401 UNAUTHORIZED`() {
            val result = client.get().uri("/api/users/me").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "status without a token")
            assertEquals(ErrorCode.UNAUTHORIZED, result.responseBody?.code, "error code")
            assertEquals("Bearer", result.responseHeaders.getFirst(HttpHeaders.WWW_AUTHENTICATE), "challenge")
        }
    }
}
