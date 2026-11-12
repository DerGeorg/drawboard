package at.dergeorg.drawboard.core.infra.security

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtIssuerValidator
import org.springframework.security.oauth2.jwt.JwtTimestampValidator
import org.springframework.security.oauth2.jwt.JwtTypeValidator
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.jwt.SupplierReactiveJwtDecoder
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm

/**
 * Token validation for any OpenID Connect provider: signature (keys from `OIDC_JWK_SET_URI`, or found through the
 * issuer's discovery document; the key set is re-read when a token names an unknown `kid`), only the algorithms
 * RS256, ES256 and PS256 (never `none`, never HS*), `iss` equals `OIDC_ISSUER_URI`, `exp`/`nbf` with Spring's
 * clock skew of 60 seconds, `aud` contains `OIDC_AUDIENCE`, and the header `typ` is `JWT`, `at+jwt` (RFC 9068, the
 * type Authelia gives its JWT access tokens) or absent. Our own decoder instead of Boot's
 * `spring.security.oauth2.resourceserver.jwt.*` because Boot cannot restrict the algorithms.
 */
@Configuration(proxyBeanMethods = false)
internal class OidcJwtDecoderConfiguration {

    /**
     * Built lazily on the first token: the application (and every test) starts without a reachable provider, and a
     * provider that is down at startup does not keep the backend from starting.
     */
    @Bean
    fun reactiveJwtDecoder(properties: OidcProperties): ReactiveJwtDecoder = SupplierReactiveJwtDecoder {
        val builder = properties.jwkSetUriOrNull
            ?.let { NimbusReactiveJwtDecoder.withJwkSetUri(it) }
            ?: NimbusReactiveJwtDecoder.withIssuerLocation(properties.issuerUri)
        ALLOWED_ALGORITHMS.forEach { builder.jwsAlgorithm(it) }
        // Nimbus would accept only typ JWT; the type is checked by tokenValidator instead (JWT or at+jwt).
        builder.validateType(false)
        builder.build().apply { setJwtValidator(tokenValidator(properties)) }
    }

    private companion object {
        val ALLOWED_ALGORITHMS = listOf(SignatureAlgorithm.RS256, SignatureAlgorithm.ES256, SignatureAlgorithm.PS256)
    }
}

/**
 * `exp`/`nbf` (60 s skew, Spring's default), `iss` exact, `typ` one of [ACCESS_TOKEN_TYPES] or absent, and `aud`
 * contains the configured audience. An ID token or a logout token can therefore never pass as an access token: their
 * `aud` is the client id, and a logout token's `typ` is `logout+jwt`.
 */
internal fun tokenValidator(properties: OidcProperties): OAuth2TokenValidator<Jwt> =
    DelegatingOAuth2TokenValidator(
        JwtTimestampValidator(),
        JwtIssuerValidator(properties.issuerUri),
        JwtTypeValidator(ACCESS_TOKEN_TYPES).apply { setAllowEmpty(true) },
        AudienceValidator(properties.audience),
        NotAGuestTokenValidator(),
    )

/** `JWT` (Keycloak and most providers) and `at+jwt` (RFC 9068 JWT access tokens, e.g. Authelia). */
private val ACCESS_TOKEN_TYPES = listOf("JWT", "at+jwt")

/** Rejects tokens that were minted for another application: `aud` must contain [audience]. */
internal class AudienceValidator(private val audience: String) : OAuth2TokenValidator<Jwt> {

    override fun validate(token: Jwt): OAuth2TokenValidatorResult =
        if (audience in token.audience.orEmpty()) {
            OAuth2TokenValidatorResult.success()
        } else {
            OAuth2TokenValidatorResult.failure(OAuth2Error("invalid_token", "The token is not meant for this application.", null))
        }
}

/**
 * A token of the OpenID Connect provider is never a guest token (S1.6): one that claims `typ = guest` is refused here,
 * whatever else it says. (Guest tokens carry our own issuer and are verified by the guest decoder; this keeps the two
 * apart even if a provider were configured with an issuer equal to ours.)
 */
internal class NotAGuestTokenValidator : OAuth2TokenValidator<Jwt> {

    override fun validate(token: Jwt): OAuth2TokenValidatorResult =
        if (token.getClaimAsString("typ") == GUEST_TYPE) {
            OAuth2TokenValidatorResult.failure(OAuth2Error("invalid_token", "This is not an access token of the provider.", null))
        } else {
            OAuth2TokenValidatorResult.success()
        }
}
