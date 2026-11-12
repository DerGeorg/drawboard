// Nimbus signs with java.util.Date; the tests craft foreign tokens with it.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.shared.security.GuestTokenIssuer
import at.dergeorg.drawboard.shared.security.GuestTokenRequest
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.PlainHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.PlainJWT
import com.nimbusds.jwt.SignedJWT
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.jwt.BadJwtException
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.Date
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

private const val ISSUER = "https://draw.example.org/guest"
private const val AUDIENCE = "drawboard-api"

/** A fresh EC P-256 key as PKCS#8 PEM - what an operator generates with `openssl`. */
private fun pemKey(): String {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val body = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(pair.private.encoded)
    return "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
}

class GuestJwtTest {

    private val clock = MutableClock()
    private val oldPem = pemKey()
    private val newPem = pemKey()

    private fun codec(vararg pems: String, issuer: String = ISSUER, audience: String = AUDIENCE) =
        GuestJwtCodec(GuestKeys.parse(pems.joinToString("\n")), issuer, audience, clock)

    private fun request(
        authTime: kotlin.time.Instant = clock.now(),
        shareExpiresAt: kotlin.time.Instant? = null,
        name: String = "Gus",
    ) = GuestTokenRequest(
        guestId = Uuid.generateV7(), shareId = Uuid.generateV7(), kind = "BOARD", resourceId = Uuid.generateV7(), role = "EDITOR",
        name = name, passwordVerified = true, authTime = authTime, shareExpiresAt = shareExpiresAt,
    )

    /** A token with arbitrary claims and header, signed with [pem]'s key - to craft what the codec must refuse. */
    private fun crafted(
        pem: String = oldPem,
        header: JWSHeader? = null,
        claims: Map<String, Any?> = emptyMap(),
        keep: Set<String> = emptySet(),
    ): String {
        val good = codec(pem)
        val issued = good.issue(request())
        val signed = SignedJWT.parse(issued.token)
        val builder = JWTClaimsSet.Builder(signed.jwtClaimsSet)
        claims.forEach { (name, value) -> builder.claim(name, value) }
        keep.forEach { builder.claim(it, null) }
        val key = GuestKeys.parse(pem).signing
        val head = header ?: JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.kid).type(JOSEObjectType("guest")).build()
        return SignedJWT(head, builder.build()).apply { sign(ECDSASigner(key.privateKey)) }.serialize()
    }

    @Nested
    inner class IssueAndVerify {

        @Test
        fun `when issuing then the token carries exactly the claims of S1-3 and verifies`() {
            val req = request(name = "Gus Guest")
            val issued = codec(oldPem).issue(req)

            val jwt = codec(oldPem).verify(issued.token)

            assertEquals(ISSUER, jwt.issuer.toString(), "iss")
            assertEquals("guest:${req.guestId}", jwt.subject, "sub")
            assertEquals(listOf(AUDIENCE), jwt.audience, "aud")
            assertEquals("guest", jwt.getClaimAsString("typ"), "typ claim")
            assertEquals("guest", jwt.headers["typ"], "typ header")
            assertEquals("ES256", jwt.headers["alg"], "ES256")
            assertEquals(req.shareId.toString(), jwt.getClaimAsString("share"), "share")
            assertEquals("BOARD:${req.resourceId}", jwt.getClaimAsString("res"), "res")
            assertEquals("EDITOR", jwt.getClaimAsString("role"), "role")
            assertEquals("Gus Guest", jwt.getClaimAsString("name"), "name")
            assertEquals(true, jwt.getClaimAsBoolean("pw"), "pw")
            assertEquals(clock.now().epochSeconds, (jwt.claims["auth_time"] as Number).toLong(), "auth_time")
            assertTrue(jwt.id.orEmpty().isNotBlank(), "jti")
            assertEquals(setOf("iss", "sub", "aud", "typ", "share", "res", "role", "name", "pw", "auth_time", "exp", "jti"),
                jwt.claims.keys, "no other claims")
        }

        @Test
        fun `when issuing then the token lives 15 minutes, at most until the link expires and at most 12 hours from auth_time`() {
            val plain = codec(oldPem).issue(request())
            val shortLink = codec(oldPem).issue(request(shareExpiresAt = clock.now() + 3.minutes))
            val late = codec(oldPem).issue(request(authTime = clock.now() - 11.hours - 55.minutes))

            assertEquals(clock.now() + 15.minutes, plain.expiresAt, "15 minutes")
            assertEquals(clock.now() + 3.minutes, shortLink.expiresAt, "never after the link")
            assertEquals(clock.now() + 5.minutes, late.expiresAt, "never after auth_time + 12 hours")
        }

        @Test
        fun `when the session has no lifetime left then issuing fails`() {
            assertFailsWith<IllegalStateException>("12 hours are over") { codec(oldPem)
                .issue(request(authTime = clock.now() - 12.hours)) }
            assertFailsWith<IllegalStateException>("link expired") { codec(oldPem)
                .issue(request(shareExpiresAt = clock.now() - 1.seconds)) }
        }

        @Test
        fun `when the name is longer than 64 characters then the claim is cut`() {
            val jwt = codec(oldPem).let { it.verify(it.issue(request(name = "x".repeat(80))).token) }

            assertEquals(64, jwt.getClaimAsString("name")!!.length, "name claim")
        }

        @Test
        fun `when the cut falls inside a surrogate pair then the pair is kept whole or dropped, never split`() {
            val name = "a".repeat(63) + "\uD83D\uDE00\uD83D\uDE00"
            val jwt = codec(oldPem).let { it.verify(it.issue(request(name = name)).token) }

            val claim = jwt.getClaimAsString("name")!!
            assertEquals(64, claim.codePointCount(0, claim.length), "64 characters, an emoji counts one")
            assertTrue(claim.last().isLowSurrogate() && claim[claim.length - 2].isHighSurrogate(), "ends with a whole pair")
        }

        @Test
        fun `when parsing a verified token then the guest has its ids, role and times`() {
            val req = request()
            val guest = codec(oldPem).let { GuestJwtCodec.parseGuest(it.verify(it.issue(req).token)) }

            assertEquals(listOf(req.guestId, req.shareId, req.resourceId), listOf(guest.id, guest.shareId, guest.resourceId), "ids")
            assertEquals(listOf("BOARD", "EDITOR", "Gus"), listOf(guest.resourceKind, guest.role, guest.name), "kind, role, name")
            assertEquals(clock.now().epochSeconds, guest.authTime.epochSeconds, "auth time")
        }
    }

    @Nested
    inner class Refusing {

        @Test
        fun `when the algorithm is not ES256 then the token is refused - alg none, HS256 with any secret, RS256`() {
            val claims = JWTClaimsSet.Builder().issuer(ISSUER).subject("guest:${Uuid.random()}").audience(AUDIENCE)
                .expirationTime(Date(clock.now().toEpochMilliseconds() + 600_000)).claim("typ", "guest").build()
            val none = PlainJWT(PlainHeader.Builder().type(JOSEObjectType("guest")).build(), claims).serialize()
            val hs = SignedJWT(JWSHeader.Builder(JWSAlgorithm.HS256).type(JOSEObjectType("guest")).keyID("x").build(), claims)
                .apply { sign(MACSigner(ByteArray(32) { 1 })) }.serialize()
            val rsa = RSAKeyGenerator(2048).generate()
            val rs = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType("guest")).keyID("x").build(), claims)
                .apply { sign(RSASSASigner(rsa)) }.serialize()

            listOf(none, hs, rs).forEach { token ->
                assertFailsWith<BadJwtException>("foreign algorithm") { codec(oldPem).verify(token) }
            }
        }

        @Test
        fun `when the issuer is another one then the token is refused`() {
            val other = codec(oldPem, issuer = "https://evil.example.org/guest").let { it.issue(request()).token }

            assertFailsWith<Exception>("wrong iss") { codec(oldPem).verify(other) }
        }

        @Test
        fun `when typ is missing or not guest, in the header or in the claims, then the token is refused`() {
            val key = GuestKeys.parse(oldPem).signing
            val jwtHeader = JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.kid).type(JOSEObjectType.JWT).build()
            val noHeaderType = JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.kid).build()

            assertFailsWith<BadJwtException>("header typ JWT") { codec(oldPem).verify(crafted(header = jwtHeader)) }
            assertFailsWith<BadJwtException>("no header typ") { codec(oldPem).verify(crafted(header = noHeaderType)) }
            assertFailsWith<BadJwtException>("claim typ is something else") { codec(oldPem)
                .verify(crafted(claims = mapOf("typ" to "access"))) }
            assertFailsWith<BadJwtException>("no claim typ") { codec(oldPem).verify(crafted(keep = setOf("typ"))) }
        }

        @Test
        fun `when the audience is missing or another one then the token is refused`() {
            assertFailsWith<Exception>("other audience") { codec(oldPem).verify(crafted(claims = mapOf("aud" to listOf("other-api")))) }
            assertFailsWith<Exception>("no audience") { codec(oldPem).verify(crafted(keep = setOf("aud"))) }
        }

        @Test
        fun `when the token is expired then it is refused, but 30 seconds of skew are tolerated and 90 are not`() {
            val token = codec(oldPem).issue(request()).token

            clock.advanceBy(15.minutes + 30.seconds)
            codec(oldPem).verify(token)
            clock.advanceBy(60.seconds)

            assertFailsWith<Exception>("expired 90 seconds ago") { codec(oldPem).verify(token) }
        }

        @Test
        fun `when the session is older than 12 hours then the token is refused even if exp lies ahead`() {
            val stale = crafted(
                claims = mapOf(
                    "auth_time" to (clock.now() - 13.hours).epochSeconds,
                    "exp" to Date(clock.now().toEpochMilliseconds() + 600_000),
                ),
            )

            assertFailsWith<Exception>("12 hour limit") { codec(oldPem).verify(stale) }
        }

        @Test
        fun `when the signature is wrong or the kid is unknown then the token is refused`() {
            val signedByOther = codec(newPem).issue(request()).token

            assertFailsWith<BadJwtException>("a key we do not have") { codec(oldPem).verify(signedByOther) }
            val tampered = codec(oldPem).issue(request()).token.let { it.dropLast(4) + "AAAA" }
            assertFailsWith<BadJwtException>("tampered signature") { codec(oldPem).verify(tampered) }
            assertFailsWith<BadJwtException>("garbage") { codec(oldPem).verify("not.a.jwt") }
        }

        @Test
        fun `when claims are malformed then the token is no guest token`() {
            assertFailsWith<BadJwtException>("sub is not guest:") { codec(oldPem).verify(crafted(claims = mapOf("sub" to "user-1"))) }
            assertFailsWith<BadJwtException>("role OWNER") { codec(oldPem).verify(crafted(claims = mapOf("role" to "OWNER"))) }
            assertFailsWith<BadJwtException>("res of no kind") { codec(oldPem)
                .verify(crafted(claims = mapOf("res" to "FILE:${Uuid.random()}"))) }
            assertFailsWith<BadJwtException>("share is no uuid") { codec(oldPem).verify(crafted(claims = mapOf("share" to "nope"))) }
        }
    }

    @Nested
    inner class KeyRotation {

        @Test
        fun `when a new key is put first then old tokens still verify, new ones are signed with the new key`() {
            val oldToken = codec(oldPem).issue(request()).token

            val rotated = codec(newPem, oldPem)

            rotated.verify(oldToken)
            val newToken = rotated.issue(request()).token
            assertEquals(GuestKeys.parse(newPem).signing.kid, SignedJWT.parse(newToken).header.keyID, "kid of the new key")
            rotated.verify(newToken)
            assertFailsWith<BadJwtException>("a replica that still has only the old key") { codec(oldPem).verify(newToken) }
        }

        @Test
        fun `when the old key is removed then its tokens stop working`() {
            val oldToken = codec(oldPem).issue(request()).token

            assertFailsWith<BadJwtException>("old key gone") { codec(newPem).verify(oldToken) }
        }

        @Test
        fun `when computing the kid then it is the fingerprint of the public key - stable and different per key`() {
            val first = GuestKeys.parse(oldPem).signing
            val again = GuestKeys.parse(oldPem).signing

            assertEquals(first.kid, again.kid, "stable")
            assertNotEquals(first.kid, GuestKeys.parse(newPem).signing.kid, "per key")
            assertEquals(43, first.kid.length, "sha256 as base64url")
        }

        @Test
        fun `when the key list holds garbage, a public key or an RSA key then it is refused with a message`() {
            assertFailsWith<IllegalArgumentException>("nothing") { GuestKeys.parse("") }
            assertFailsWith<IllegalArgumentException>("not PEM") { GuestKeys.parse("secret") }
            val rsa = Base64.getMimeEncoder(64,
                "\n".toByteArray()).encodeToString(RSAKeyGenerator(2048).generate().toPrivateKey().encoded)
            val pem = "-----BEGIN PRIVATE KEY-----\n$rsa\n-----END PRIVATE KEY-----"
            assertFailsWith<IllegalArgumentException>("RSA") { GuestKeys.parse(pem) }
        }
    }

    @Nested
    inner class Configuration {

        private val oidc = OidcProperties(issuerUri = "https://sso.example.org", audience = AUDIENCE)

        @Test
        fun `when guests are off then no keys are needed and no guest issuer is accepted`() {
            val service = IssuerConfiguration().guestTokenService(GuestProperties(publicUrl = "https://draw.example.org"), oidc, clock)

            assertEquals(null, service.codec, "no codec")
            assertFailsWith<IllegalStateException>("issuing") { service.issue(request()) }
        }

        @Test
        fun `when guests are on without keys then the start fails`() {
            val failure = assertFailsWith<IllegalArgumentException>("no keys") {
                IssuerConfiguration().guestTokenService(GuestProperties(enabled = true, publicUrl = "https://draw.example.org"), oidc,
                    clock)
            }

            assertTrue("DRAWBOARD_GUEST_SIGNING_KEYS" in failure.message.orEmpty(), "names the setting")
        }

        @Test
        fun `when the guest issuer equals the OIDC issuer then the start fails`() {
            val same = OidcProperties(issuerUri = "https://draw.example.org/guest", audience = AUDIENCE)

            assertFailsWith<IllegalArgumentException>("same issuer") {
                IssuerConfiguration().guestTokenService(GuestProperties(true, oldPem, null, "https://draw.example.org"), same, clock)
            }
        }

        @Test
        fun `when guests are on with a key then guest tokens are issued with the issuer public url plus guest`() {
            val service = IssuerConfiguration().guestTokenService(GuestProperties(true, oldPem.replace("\n", "\\n"), null,
                "https://draw.example.org/"), oidc, clock)

            val jwt = service.codec!!.verify(service.issue(request()).token)

            assertEquals("https://draw.example.org/guest", jwt.issuer.toString(), "issuer")
            assertEquals(GuestTokenIssuer.SESSION_LIMIT_HOURS, 12, "the limit of S1.4")
        }
    }

    @Nested
    inner class OidcSide {

        @Test
        fun `when a token of the provider claims typ guest then the OIDC validator refuses it`() {
            val jwt = org.springframework.security.oauth2.jwt.Jwt.withTokenValue("t").header("alg", "RS256").claim("typ",
                "guest").claim("sub", "x").build()

            assertTrue(NotAGuestTokenValidator().validate(jwt).hasErrors(), "typ guest is never an OIDC access token")
        }

        @Test
        fun `when a token has no typ claim then the guest check lets the rest of the validators decide`() {
            val jwt = org.springframework.security.oauth2.jwt.Jwt.withTokenValue("t").header("alg", "RS256").claim("sub", "x").build()

            assertEquals(false, NotAGuestTokenValidator().validate(jwt).hasErrors(), "no typ: not a guest claim")
        }
    }

    @Suppress("unused")
    private val unusedFixedNow = FIXED_NOW
}
