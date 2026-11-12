// Spring Security's Jwt claims (exp, nbf, iat) are java.time.Instant: the one place that cannot use kotlin.time.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.core.infra.security

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.jwt.Jwt
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val ISSUER_X = "https://idp.example.test/realms/x"
private const val OLD = 900L

class TokenValidatorTest {

    private val validator = tokenValidator(properties())

    private fun expiredSecondsAgo(seconds: Long) =
        valid(mapOf("iat" to Instant.now().minusSeconds(OLD), "exp" to Instant.now().minusSeconds(seconds)))

    private fun valid(overrides: Map<String, Any> = emptyMap()): Jwt {
        val now = Instant.now()
        val claims = mapOf("iss" to ISSUER_X, "sub" to "s", "aud" to listOf("drawboard-api"), "exp" to now.plusSeconds(300), "iat" to now)
        return token(claims + overrides)
    }

    @Nested
    inner class Validation {

        @Test
        fun `when issuer, audience and expiry are right then the token is valid`() {
            assertFalse(validator.validate(valid()).hasErrors(), "valid token")
        }

        @Test
        fun `when the audience is missing or another one then the token is rejected`() {
            assertTrue(validator.validate(valid(mapOf("aud" to listOf("other-api")))).hasErrors(), "other audience")
            assertTrue(validator.validate(valid(mapOf("aud" to listOf("x", "drawboard-api")))).hasErrors().not(), "audience among several")
            assertTrue(
                validator.validate(token(mapOf("iss" to ISSUER_X, "sub" to "s", "exp" to Instant.now().plusSeconds(60)))).hasErrors(),
                "no aud",
            )
        }

        @Test
        fun `when the issuer differs even by a trailing slash then the token is rejected`() {
            assertTrue(validator.validate(valid(mapOf("iss" to "https://idp.example.test/realms/x/"))).hasErrors(), "trailing slash")
            assertTrue(validator.validate(valid(mapOf("iss" to "https://evil.example.test/realms/x"))).hasErrors(), "other issuer")
        }

        @Test
        fun `when the token expired more than the clock skew ago then it is rejected, within the skew it is accepted`() {
            assertTrue(
                validator.validate(expiredSecondsAgo(120)).hasErrors(),
                "expired 2 minutes ago",
            )
            assertFalse(
                validator.validate(expiredSecondsAgo(30)).hasErrors(),
                "expired 30 seconds ago, inside the 60 s skew",
            )
        }

        @Test
        fun `when the token is not valid yet beyond the skew then it is rejected`() {
            assertTrue(validator.validate(valid(mapOf("nbf" to Instant.now().plusSeconds(300)))).hasErrors(), "nbf in 5 minutes")
        }
    }

    @Nested
    inner class Configuration {

        @Test
        fun `when the audience is empty then the configuration is refused`() {
            assertFailsWith<IllegalArgumentException>("OIDC_AUDIENCE is required") {
                OidcProperties(issuerUri = "https://idp.example.test", audience = " ")
            }
        }

        @Test
        fun `when the issuer is empty then the configuration is refused`() {
            assertFailsWith<IllegalArgumentException>("OIDC_ISSUER_URI is required") {
                OidcProperties(issuerUri = "", audience = "drawboard-api")
            }
            assertEquals("a", OidcProperties(issuerUri = "i", audience = "a").audience, "valid configuration")
        }
    }
}
