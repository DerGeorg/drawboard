// Jwt.getExpiresAt() returns java.time.Instant: like the R2DBC converters, this is a place that has to name it.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.core.infra.types

import org.springframework.security.oauth2.jwt.Jwt
import kotlin.time.Clock
import kotlin.time.Instant

/** The `exp` of the token as the application's [Instant], or null if the token has none. */
internal fun Jwt.expiresAtOrNull(): Instant? = expiresAt?.let { Instant.fromEpochSeconds(it.epochSecond) }

/** Nimbus builds the `exp` claim from a [java.util.Date]. */
internal fun com.nimbusds.jwt.JWTClaimsSet.Builder.expiresAt(at: Instant): com.nimbusds.jwt.JWTClaimsSet.Builder =
    expirationTime(java.util.Date(at.toEpochMilliseconds()))

/** The `exp` of a parsed Nimbus claims set. */
internal fun com.nimbusds.jwt.JWTClaimsSet.expiryOrNull(): Instant? = expirationTime?.let { Instant.fromEpochMilliseconds(it.time) }

/** Spring's [Jwt] wants `exp` as a [java.time.Instant] claim. */
internal fun MutableMap<String, Any>.putExpiry(at: Instant) {
    this["exp"] = java.time.Instant.ofEpochMilli(at.toEpochMilliseconds())
}

/** `exp` / `nbf` with a clock skew of [skewSeconds], measured by the application's [clock] (so tests move it). */
internal fun timestampValidator(clock: Clock, skewSeconds: Long): org.springframework.security.oauth2.core.OAuth2TokenValidator<Jwt> =
    org.springframework.security.oauth2.jwt.JwtTimestampValidator(java.time.Duration.ofSeconds(skewSeconds)).apply {
        setClock(
            object : java.time.Clock() {
                override fun getZone(): java.time.ZoneId = java.time.ZoneOffset.UTC

                override fun withZone(zone: java.time.ZoneId): java.time.Clock = this

                override fun instant(): java.time.Instant = java.time.Instant.ofEpochMilli(clock.now().toEpochMilliseconds())
            },
        )
    }
