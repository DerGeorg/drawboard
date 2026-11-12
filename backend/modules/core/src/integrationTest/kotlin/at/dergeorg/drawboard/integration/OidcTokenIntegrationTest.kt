// Signed test tokens carry java.time claims (exp, iat); the Nimbus API takes java.util.Date. The one place that cannot use kotlin.time.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.net.InetSocketAddress
import java.util.Date
import kotlin.test.assertEquals

/**
 * The real token validation, no mockJwt: tokens signed with a key whose JWKS a local HTTP server serves, sent as
 * `Authorization: Bearer`. Proves signature, issuer, audience, expiry and the algorithm allowlist end to end.
 */
@SpringBootTest(
    properties = [
        "OIDC_ISSUER_URI=$TOKEN_ISSUER",
        "OIDC_AUDIENCE=$AUDIENCE",
        "DRAWBOARD_ADMIN_GROUP=$ADMIN_GROUP",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class OidcTokenIntegrationTest(private val client: WebTestClient) {

    private fun token(
        issuer: String = TOKEN_ISSUER,
        audience: List<String> = listOf(AUDIENCE),
        expiresInSeconds: Long = 300,
        groups: List<String> = emptyList(),
        subject: String = "sub-${System.nanoTime()}",
        type: String? = null,
    ): String {
        val claims = JWTClaimsSet.Builder()
            .issuer(issuer).subject(subject).audience(audience)
            .expirationTime(Date(System.currentTimeMillis() + expiresInSeconds * 1000))
            .claim("preferred_username", "tester").claim("groups", groups).build()
        val header = JWSHeader.Builder(JWSAlgorithm.RS256).keyID(KEY.keyID)
            .apply { type?.let { type(JOSEObjectType(it)) } }.build()
        return SignedJWT(header, claims)
            .apply { sign(RSASSASigner(KEY)) }.serialize()
    }

    private fun getMe(token: String) = client.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")
        .exchange().expectBody<String>().returnResult()

    @Nested
    inner class AcceptedAndRejected {

        @Test
        fun `when a correctly signed token for this audience arrives then 200`() {
            assertEquals(HttpStatus.OK, getMe(token()).status, "valid token")
        }

        @Test
        fun `when the token is typed JWT or at+jwt (RFC 9068, Authelia) then 200`() {
            assertEquals(HttpStatus.OK, getMe(token(type = "JWT")).status, "typ JWT (Keycloak)")
            assertEquals(HttpStatus.OK, getMe(token(type = "at+jwt")).status, "typ at+jwt (Authelia)")
        }

        @Test
        fun `when the token has another type, e g a logout token, then 401`() {
            assertEquals(HttpStatus.UNAUTHORIZED, getMe(token(type = "logout+jwt")).status, "typ logout+jwt")
        }

        @Test
        fun `when the token's audience is another application then 401`() {
            assertEquals(HttpStatus.UNAUTHORIZED, getMe(token(audience = listOf("other-api"))).status, "wrong audience")
        }

        @Test
        fun `when the token's issuer is another one then 401`() {
            assertEquals(HttpStatus.UNAUTHORIZED, getMe(token(issuer = "https://evil.example.test/realms/x")).status, "wrong issuer")
        }

        @Test
        fun `when the token expired long ago then 401`() {
            assertEquals(HttpStatus.UNAUTHORIZED, getMe(token(expiresInSeconds = -3600)).status, "expired")
        }

        @Test
        fun `when the token is signed by an unknown key then 401`() {
            val foreign = RSAKeyGenerator(2048).keyID(KEY.keyID).generate()
            val claims = JWTClaimsSet.Builder().issuer(TOKEN_ISSUER).subject("s").audience(AUDIENCE)
                .expirationTime(Date(System.currentTimeMillis() + 300_000)).build()
            val forged = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(foreign.keyID).build(), claims)
                .apply { sign(RSASSASigner(foreign)) }.serialize()

            assertEquals(HttpStatus.UNAUTHORIZED, getMe(forged).status, "signature does not match the published key")
        }

        @Test
        fun `when the token uses HS256 or alg none then 401`() {
            val claims = JWTClaimsSet.Builder().issuer(TOKEN_ISSUER).subject("s").audience(AUDIENCE)
                .expirationTime(Date(System.currentTimeMillis() + 300_000)).build()
            val hs256 = SignedJWT(JWSHeader(JWSAlgorithm.HS256), claims).apply { sign(MACSigner(ByteArray(32) { 7 })) }.serialize()
            val none = listOf("""{"alg":"none"}""", claims.toString()).joinToString(".") {
                java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(it.toByteArray())
            } + "."

            assertEquals(HttpStatus.UNAUTHORIZED, getMe(hs256).status, "HS256 is not on the allowlist")
            assertEquals(HttpStatus.UNAUTHORIZED, getMe(none).status, "alg none")
        }
    }

    @Nested
    inner class Admin {

        private fun adminOf(token: String): Boolean? {
            val result = client.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer $token")
                .exchange().expectBody<CurrentUser>().returnResult()
            return result.responseBody?.admin
        }

        @Test
        fun `when the token's groups contain the admin group then admin is true, without it false`() {
            assertEquals(true, adminOf(token(groups = listOf(ADMIN_GROUP))), "member of the admin group")
            assertEquals(false, adminOf(token(groups = listOf("drawboard-users"))), "not a member")
        }

        @Test
        fun `when the same login comes first as admin and later without the group then admin is gone at once`() {
            val subject = "demoted-${System.nanoTime()}"

            assertEquals(true, adminOf(token(groups = listOf(ADMIN_GROUP), subject = subject)), "first as admin")
            assertEquals(false, adminOf(token(groups = emptyList(), subject = subject)), "admin status is not cached")
        }

        @Test
        fun `when the error is a 401 then the body is the ErrorModel`() {
            val result = client.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer ${token(audience = listOf("x"))}")
                .exchange().expectBody<ErrorModel>().returnResult()

            assertEquals("UNAUTHORIZED", result.responseBody?.code?.value, "error code")
        }
    }

    companion object {
        private val KEY: RSAKey = RSAKeyGenerator(2048).keyID("test-key").generate()
        private val jwks: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/jwks") { exchange ->
                val body = JWKSet(KEY.toPublicJWK()).toString().toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
            Runtime.getRuntime().addShutdownHook(Thread { stop(0) })
        }

        @JvmStatic
        @DynamicPropertySource
        fun jwksUri(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { "http://127.0.0.1:${jwks.address.port}/jwks" }
        }
    }
}

private const val TOKEN_ISSUER = "https://idp.example.test/realms/drawboard"
