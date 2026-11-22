package at.dergeorg.drawboard.api.domain.users.users

import at.dergeorg.drawboard.api.domain.users.users.provides.UsersApiUseCase
import at.dergeorg.drawboard.api.domain.users.users.provides.impl.UsersController
import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import at.dergeorg.drawboard.contract.model.ColorTheme
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.UserPreferences
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.users.testing.UserProfileFixtures.ALICE_ID
import com.ninjasquad.springmockk.MockkBean
import io.mockk.coEvery
import io.mockk.coVerify
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import at.dergeorg.drawboard.shared.error.ErrorCode as DomainErrorCode

/** Slice test: UsersController + WebFlux + error rendering; the API use case is a mock. Authentication: RouteTableIntegrationTest. */
@WebFluxTest(UsersController::class)
@Import(WebSliceTestConfiguration::class)
class UsersControllerTest(private val client: WebTestClient) {

    @MockkBean
    private lateinit var users: UsersApiUseCase

    @Nested
    inner class GetCurrentUser {

        @Test
        fun `when GET users me given a signed-in user then 200 with the user`() {
            val alice = CurrentUser(
                id = ALICE_ID, username = "alice", admin = true, guestLinksEnabled = false, gifsEnabled = true, theme = ColorTheme.SYSTEM,
                email = "alice@example.test",
            )
            coEvery { users.getCurrentUser() } returns alice

            val result = client.get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of GET /api/users/me")
            assertEquals(alice, result.responseBody, "user in the body")
        }

        @Test
        fun `when GET users me given the token is not usable then 401 UNAUTHORIZED with a Bearer challenge`() {
            coEvery { users.getCurrentUser() } throws DomainException(DomainErrorCode.UNAUTHORIZED)

            val result = client.get().uri("/api/users/me").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "status for an unusable token")
            assertEquals(ErrorCode.UNAUTHORIZED, result.responseBody?.code, "error code")
            assertEquals("Bearer", result.responseHeaders.getFirst(HttpHeaders.WWW_AUTHENTICATE), "RFC 6750 challenge")
        }
    }

    @Nested
    inner class UpdateUserPreferences {

        @Test
        fun `when PUT users me preferences given a theme then 200 with the stored preferences`() {
            val preferences = UserPreferences(theme = ColorTheme.DARK)
            coEvery { users.updateUserPreferences(preferences) } returns preferences

            val result = client.put().uri("/api/users/me/preferences").bodyValue(preferences).exchange()
                .expectBody<UserPreferences>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of PUT /api/users/me/preferences")
            assertEquals(preferences, result.responseBody, "stored preferences in the body")
        }

        @Test
        fun `when PUT users me preferences given an unknown theme then 400 and nothing is stored`() {
            val result = client.put().uri("/api/users/me/preferences").contentType(MediaType.APPLICATION_JSON)
                .bodyValue("""{"theme":"SEPIA"}""").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a value outside the enum")
            coVerify(exactly = 0) { users.updateUserPreferences(any()) }
        }

        @Test
        fun `when PUT users me preferences given no theme then 400 and nothing is stored`() {
            val result = client.put().uri("/api/users/me/preferences").contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}").exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "status for a missing required field")
            coVerify(exactly = 0) { users.updateUserPreferences(any()) }
        }
    }
}
