package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.core.infra.types.expiresAt
import at.dergeorg.drawboard.core.infra.types.expiresAtOrNull
import at.dergeorg.drawboard.core.infra.types.expiryOrNull
import at.dergeorg.drawboard.core.infra.types.putExpiry
import at.dergeorg.drawboard.core.infra.types.timestampValidator
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.security.GuestTokenIssuer
import at.dergeorg.drawboard.shared.security.GuestTokenRequest
import at.dergeorg.drawboard.shared.security.IssuedGuestToken
import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.crypto.ECDSAVerifier
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.BadJwtException
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtIssuerValidator
import org.springframework.security.oauth2.jwt.JwtValidationException
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import reactor.core.publisher.Mono
import java.text.ParseException
import kotlin.time.Clock
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** The `typ` of a guest token, in the header and in the claims (S1.3, S1.6). */
internal const val GUEST_TYPE = "guest"

/** The prefix of the `sub` of a guest: `guest:<random>`. */
internal const val GUEST_SUBJECT_PREFIX = "guest:"

/**
 * Issues and verifies the application's own guest tokens (S1.3 - S1.6).
 *
 * * Signed with ES256 (P-256) by the FIRST configured key; verified with ANY configured key, picked by `kid` (S1.5).
 *   Nothing else is accepted: not another algorithm (never `none`, never HS*), not an unknown `kid`.
 * * Claims: `iss` = [issuer], `sub` = `guest:<random>`, `aud` = [audience], `typ` = `guest` (also as header `typ`),
 *   `share`, `res` (`BOARD:<id>` / `FOLDER:<id>`), `role`, `name` (at most 64 characters), `pw`, `auth_time`, `exp`, `jti`.
 * * `exp` is at most 15 minutes away, never after the link's expiry and never later than 12 hours after `auth_time` (S1.4).
 * * Verification checks the signature, the exact issuer, the audience, `typ`, `exp` with a skew of 60 seconds and the
 *   12 hour limit; the claims must be well formed, otherwise the token is no guest token at all.
 */
internal class GuestJwtCodec(
    private val keys: GuestKeys,
    private val issuer: String,
    private val audience: String,
    private val clock: Clock,
) {

    /** The issuer this codec signs and accepts. */
    val issuerName: String get() = issuer

    private val validator: OAuth2TokenValidator<Jwt> = DelegatingOAuth2TokenValidator(
        timestampValidator(clock, SKEW_SECONDS),
        JwtIssuerValidator(issuer),
        AudienceValidator(audience),
        SessionLimitValidator(clock),
    )

    fun issue(request: GuestTokenRequest): IssuedGuestToken {
        val now = clock.now()
        val limit = request.authTime + GuestTokenIssuer.SESSION_LIMIT_HOURS.hours
        val expiresAt = listOfNotNull(now + GuestTokenIssuer.TOKEN_MINUTES.minutes, request.shareExpiresAt, limit).min()
        check(expiresAt > now) { "the guest session of share ${request.shareId} has no lifetime left" }
        val claims = JWTClaimsSet.Builder()
            .issuer(issuer)
            .subject(GUEST_SUBJECT_PREFIX + request.guestId)
            .audience(audience)
            .claim("typ", GUEST_TYPE)
            .claim("share", request.shareId.toString())
            .claim("res", "${request.kind}:${request.resourceId}")
            .claim("role", request.role)
            .claim("name", cutName(request.name))
            .claim("pw", request.passwordVerified)
            .claim("auth_time", request.authTime.epochSeconds)
            .expiresAt(expiresAt)
            .jwtID(Uuid.generateV7().toString())
            .build()
        val key = keys.signing
        val header = JWSHeader.Builder(JWSAlgorithm.ES256).keyID(key.kid).type(JOSEObjectType(GUEST_TYPE)).build()
        val jwt = SignedJWT(header, claims).apply { sign(ECDSASigner(key.privateKey)) }
        return IssuedGuestToken(jwt.serialize(), expiresAt)
    }

    /** @throws BadJwtException for anything that is not a valid, current guest token of ours. */
    @Suppress("ThrowsCount") // one check, one precise refusal
    fun verify(token: String): Jwt {
        val signed = try {
            SignedJWT.parse(token)
        } catch (_: ParseException) {
            throw BadJwtException("Invalid token")
        }
        val header = signed.header
        if (header.algorithm != JWSAlgorithm.ES256) throw BadJwtException("Unsupported algorithm")
        if (header.type?.type != GUEST_TYPE) throw BadJwtException("Not a guest token")
        val key = keys.byKid(header.keyID) ?: throw BadJwtException("Unknown key")
        if (!signed.verify(ECDSAVerifier(key.publicKey))) throw BadJwtException("Invalid signature")
        val claims = try {
            signed.jwtClaimsSet
        } catch (_: ParseException) {
            throw BadJwtException("Invalid claims")
        }
        val jwt = toJwt(token, signed, claims)
        if (jwt.getClaimAsString("typ") != GUEST_TYPE) throw BadJwtException("Not a guest token")
        parseGuest(jwt) // malformed claims -> BadJwtException
        val result = validator.validate(jwt)
        if (result.hasErrors()) throw JwtValidationException("Invalid guest token", result.errors)
        return jwt
    }

    private fun toJwt(token: String, signed: SignedJWT, claims: JWTClaimsSet): Jwt {
        val exp = claims.expiryOrNull() ?: throw BadJwtException("No expiry")
        return Jwt.withTokenValue(token)
            .headers { it.putAll(signed.header.toJSONObject()) }
            .claims {
                it.putAll(claims.claims)
                it.putExpiry(exp)
            }
            .build()
    }

    /** At most [MAX_NAME] characters (code points - an emoji is one), never in the middle of a surrogate pair. */
    private fun cutName(name: String): String =
        if (name.codePointCount(0, name.length) <= MAX_NAME) name else name.substring(0, name.offsetByCodePoints(0, MAX_NAME))

    companion object {
        private const val SKEW_SECONDS = 60L
        private const val MAX_NAME = 64

        /** The guest a verified token stands for; [BadJwtException] if a claim is missing or malformed. */
        @Suppress("ThrowsCount")
        fun parseGuest(jwt: Jwt): CurrentGuest {
            fun bad(): Nothing = throw BadJwtException("Malformed guest token")
            val subject = jwt.subject?.takeIf { it.startsWith(GUEST_SUBJECT_PREFIX) } ?: bad()
            val res = jwt.getClaimAsString("res")?.split(':', limit = 2)?.takeIf { it.size == 2 } ?: bad()
            val kind = res[0].takeIf { it == "BOARD" || it == "FOLDER" } ?: bad()
            val role = jwt.getClaimAsString("role")?.takeIf { it in GUEST_ROLES } ?: bad()
            val name = jwt.getClaimAsString("name")?.takeIf { it.isNotBlank() && it.codePointCount(0, it.length) <= MAX_NAME } ?: bad()
            val authTime = (jwt.claims["auth_time"] as? Number)?.toLong() ?: bad()
            val expiresAt = jwt.expiresAtOrNull() ?: bad()
            return try {
                CurrentGuest(
                    id = Uuid.parse(subject.removePrefix(GUEST_SUBJECT_PREFIX)),
                    shareId = Uuid.parse(jwt.getClaimAsString("share") ?: bad()),
                    resourceKind = kind,
                    resourceId = Uuid.parse(res[1]),
                    role = role,
                    name = name,
                    authTime = Instant.fromEpochSeconds(authTime),
                    tokenExpiresAt = expiresAt,
                    passwordVerified = jwt.getClaimAsBoolean("pw") ?: bad(),
                )
            } catch (_: IllegalArgumentException) {
                bad()
            }
        }

        private val GUEST_ROLES = setOf("EDITOR", "COMMENTER", "VIEWER")
    }
}

/** A guest session ends 12 hours after its first exchange, however often it was renewed (S1.4). */
private class SessionLimitValidator(private val clock: Clock) : OAuth2TokenValidator<Jwt> {

    override fun validate(token: Jwt): OAuth2TokenValidatorResult {
        val authTime = (token.claims["auth_time"] as? Number)?.toLong()
        val over = authTime == null || clock.now() >= Instant.fromEpochSeconds(authTime) + GuestTokenIssuer.SESSION_LIMIT_HOURS.hours
        return if (over) {
            OAuth2TokenValidatorResult.failure(OAuth2Error("invalid_token", "The guest session has ended.", null))
        } else {
            OAuth2TokenValidatorResult.success()
        }
    }
}

/** The guest decoder of the resource server: one decoder per issuer, this is the one for ours (S1.6). */
internal class GuestJwtDecoder(private val codec: GuestJwtCodec) : ReactiveJwtDecoder {

    override fun decode(token: String): Mono<Jwt> = Mono.fromCallable { codec.verify(token) }
}

/**
 * The [GuestTokenIssuer] of the application. Guests switched off (the default): no codec, [issue] fails - the exchange
 * never asks for a token then.
 */
internal class GuestSigner(val codec: GuestJwtCodec?) : GuestTokenIssuer {

    override fun issue(request: GuestTokenRequest): IssuedGuestToken =
        checkNotNull(codec) { "guest access is switched off (DRAWBOARD_GUESTS_ENABLED=false)" }.issue(request)
}
