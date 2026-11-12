package at.dergeorg.drawboard.core.infra.security

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.jwt.Jwt
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant

private const val ISSUER = "https://idp.example.test/realms/x"

internal fun token(claims: Map<String, Any>): Jwt = Jwt.withTokenValue("t").header("alg", "RS256").claims { it.putAll(claims) }.build()

internal fun properties(
    claimUsername: String = "preferred_username",
    claimGroups: String = "groups",
    adminGroup: String? = null,
) = OidcProperties(
    issuerUri = ISSUER,
    audience = "drawboard-api",
    claimUsername = claimUsername,
    claimGroups = claimGroups,
    adminGroup = adminGroup,
)

class JwtCurrentUserMapperTest {

    private val base = mapOf("iss" to ISSUER, "sub" to "s-1")

    @Nested
    inner class TokenExpiry {

        @Test
        fun `when mapping a token with exp then the expiry is kept for the collaboration ticket, without exp it is null`() {
            val mapper = JwtCurrentUserMapper(properties())

            assertEquals(
                Instant.fromEpochSeconds(1_800_000_000),
                mapper.map(token(base + mapOf("exp" to java.time.Instant.ofEpochSecond(1_800_000_000))))?.tokenExpiresAt,
                "exp",
            )
            assertNull(mapper.map(token(base))?.tokenExpiresAt, "no exp")
        }
    }

    @Nested
    inner class Identity {

        @Test
        fun `when mapping a token then the identity is issuer and subject, never username or email`() {
            val user = JwtCurrentUserMapper(properties()).map(token(base + mapOf("preferred_username" to "alice", "email" to "a@x.test")))

            assertEquals(ISSUER to "s-1", user?.let { it.issuer to it.subject }, "login key")
        }

        @Test
        fun `when mapping a token without sub or iss then nobody is identified`() {
            val mapper = JwtCurrentUserMapper(properties())

            assertNull(mapper.map(token(mapOf("iss" to ISSUER, "preferred_username" to "x"))), "no sub")
            assertNull(mapper.map(token(mapOf("sub" to "s-1"))), "no iss")
        }

        @Test
        fun `when the username claim is missing then the subject is used`() {
            assertEquals("s-1", JwtCurrentUserMapper(properties()).map(token(base))?.username, "fallback username")
        }

        @Test
        fun `when another username claim is configured then that one is read`() {
            val mapper = JwtCurrentUserMapper(properties(claimUsername = "upn"))
            val user = mapper.map(token(base + mapOf("upn" to "a@corp", "preferred_username" to "other")))
            assertEquals("a@corp", user?.username, "configured username claim")
        }
    }

    @Nested
    inner class Email {

        @Test
        fun `when email_verified is true then the email is taken`() {
            val user = JwtCurrentUserMapper(properties()).map(token(base + mapOf("email" to "a@x.test", "email_verified" to true)))

            assertEquals("a@x.test", user?.email, "verified email")
        }

        @Test
        fun `when email_verified is false or missing then the email is dropped`() {
            val mapper = JwtCurrentUserMapper(properties())

            assertNull(mapper.map(token(base + mapOf("email" to "a@x.test", "email_verified" to false)))?.email, "unverified")
            assertNull(mapper.map(token(base + mapOf("email" to "a@x.test")))?.email, "no email_verified claim")
        }
    }

    @Nested
    inner class AdminAndGroups {

        @Test
        fun `when the groups contain the admin group exactly then admin is true`() {
            val mapper = JwtCurrentUserMapper(properties(adminGroup = "drawboard-admins"))
            val user = mapper.map(token(base + mapOf("groups" to listOf("a", "drawboard-admins"))))
            assertTrue(user?.admin == true, "admin from the current token")
            assertEquals(setOf("a", "drawboard-admins"), user?.groups, "groups")
        }

        @Test
        fun `when the admin group only matches partly or in another case then admin is false`() {
            val mapper = JwtCurrentUserMapper(properties(adminGroup = "drawboard-admins"))

            assertFalse(
                mapper.map(token(base + mapOf("groups" to listOf("drawboard-admins-x", "Drawboard-Admins"))))?.admin == true,
                "exact match only",
            )
        }

        @Test
        fun `when no admin group is configured then nobody is admin, not even one named admin`() {
            val mapper = JwtCurrentUserMapper(properties(adminGroup = ""))

            assertFalse(mapper.map(token(base + mapOf("groups" to listOf("admin", ""))))?.admin == true, "fail closed")
        }

        @Test
        fun `when the groups claim is a dot path then nested values are read`() {
            val claims = base + mapOf("resource_access" to mapOf("drawboard-api" to mapOf("roles" to listOf("boss"))))
            val mapper = JwtCurrentUserMapper(properties(claimGroups = "resource_access.drawboard-api.roles", adminGroup = "boss"))
            val user = mapper.map(token(claims))

            assertEquals(setOf("boss"), user?.groups, "nested groups")
            assertTrue(user?.admin == true, "admin from the nested groups")
        }

        @Test
        fun `when the groups claim is one string then it is split at spaces and commas`() {
            val user = JwtCurrentUserMapper(properties()).map(token(base + mapOf("groups" to "a b,c")))

            assertEquals(setOf("a", "b", "c"), user?.groups, "split groups")
        }

        @Test
        fun `when a claim name itself contains dots then the whole name wins`() {
            val mapper = JwtCurrentUserMapper(properties(claimGroups = "https://x.test/groups"))
            val user = mapper.map(token(base + mapOf("https://x.test/groups" to listOf("g"))))
            assertEquals(setOf("g"), user?.groups, "namespaced claim")
        }
    }
}
