package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** DRAWBOARD_ADMIN_GROUP empty (the default): nobody is admin - fail closed, no "first user is admin". */
@SpringBootTest(
    properties = [
        "OIDC_ISSUER_URI=http://localhost:1/realms/never-contacted",
        "OIDC_AUDIENCE=$AUDIENCE",
        "DRAWBOARD_ADMIN_GROUP=",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class EmptyAdminGroupIntegrationTest(private val client: WebTestClient) {

    @Test
    fun `when no admin group is configured then even a member of a group called admin gets admin false`() {
        val user = ALICE.copy(subject = "first-user", groups = setOf("drawboard-admins", "admin", ""))

        val me = client.signedInAs(user).get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody

        assertEquals(false, me?.admin, "empty configuration means nobody is admin")
    }

    @Test
    fun `when a browser origin calls the API then no CORS header is sent`() {
        val result = client.signedInAs(ALICE).get().uri("/api/users/me").header(HttpHeaders.ORIGIN, "https://evil.example.test")
            .exchange().expectBody<String>().returnResult()

        assertNull(result.responseHeaders.getFirst(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN), "CORS is off for /api")
        assertNull(result.responseHeaders.getFirst(HttpHeaders.SET_COOKIE), "stateless: no cookie, no session")
    }
}
