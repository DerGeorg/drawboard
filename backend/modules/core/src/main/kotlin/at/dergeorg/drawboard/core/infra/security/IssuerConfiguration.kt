package at.dergeorg.drawboard.core.infra.security

import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.authentication.ReactiveAuthenticationManagerResolver
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.authentication.JwtIssuerReactiveAuthenticationManagerResolver
import org.springframework.security.oauth2.server.resource.authentication.JwtReactiveAuthenticationManager
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import kotlin.time.Clock

/**
 * Two issuers of bearer tokens (S1.6), from a FIXED list: the OpenID Connect provider and - only when guests are
 * switched on - the application itself. [JwtIssuerReactiveAuthenticationManagerResolver] reads the unverified `iss` only
 * to pick the decoder; each decoder then checks the signature and the exact issuer itself. An issuer that is not on the
 * list is an invalid token (401), never looked up, never discovered.
 */
@Configuration(proxyBeanMethods = false)
internal class IssuerConfiguration {

    @Bean
    fun guestTokenService(properties: GuestProperties, oidc: OidcProperties, clock: Clock): GuestSigner {
        require(!properties.issuer.trimEnd('/').equals(oidc.issuerUri.trimEnd('/'),
            ignoreCase = true) || properties.publicUrl.isNullOrBlank()) {
            "The guest token issuer (DRAWBOARD_PUBLIC_URL + /guest) must differ from OIDC_ISSUER_URI: " +
                "otherwise a token of one issuer could be taken for the other"
        }
        if (!properties.enabled) return GuestSigner(codec = null)
        require(!properties.publicUrl.isNullOrBlank()) { "DRAWBOARD_PUBLIC_URL must be set to issue guest tokens" }
        val keys = GuestKeys.parse(properties.pem())
        return GuestSigner(GuestJwtCodec(keys, properties.issuer, oidc.audience, clock))
    }

    @Bean
    fun bearerTokenAuthenticationManagerResolver(
        oidc: OidcProperties,
        @Qualifier("reactiveJwtDecoder") oidcDecoder: ReactiveJwtDecoder,
        guests: GuestSigner,
    ): ReactiveAuthenticationManagerResolver<ServerWebExchange> {
        val managers = buildMap<String, ReactiveAuthenticationManager> {
            put(oidc.issuerUri, JwtReactiveAuthenticationManager(oidcDecoder))
            guests.codec?.let { codec ->
                put(
                    guestIssuer(codec),
                    JwtReactiveAuthenticationManager(GuestJwtDecoder(codec)).apply {
                        setJwtAuthenticationConverter(GuestAuthenticationConverter())
                    },
                )
            }
        }
        return JwtIssuerReactiveAuthenticationManagerResolver { issuer -> Mono.justOrEmpty(managers[issuer]) }
    }

    private fun guestIssuer(codec: GuestJwtCodec) = codec.issuerName
}
