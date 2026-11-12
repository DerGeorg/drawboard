package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.context.CurrentGuestProvider
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.core.convert.converter.Converter
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Component
import reactor.core.publisher.Mono

/**
 * A guest as a Spring Security principal of its own kind (S1.7): NOT a [org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken].
 * The route table, the user mapping and every `is JwtAuthenticationToken` check therefore see a guest as "not a signed-in user".
 */
internal class GuestAuthenticationToken(val jwt: Jwt, val guest: CurrentGuest) :
    AbstractAuthenticationToken(listOf(SimpleGrantedAuthority("ROLE_GUEST"))) {

    init {
        isAuthenticated = true
    }

    override fun getCredentials(): Any = jwt

    override fun getPrincipal(): Any = guest
}

/** Turns the claims of a verified guest token into the guest's authentication. */
internal class GuestAuthenticationConverter : Converter<Jwt, Mono<AbstractAuthenticationToken>> {

    override fun convert(jwt: Jwt): Mono<AbstractAuthenticationToken> =
        Mono.fromCallable { GuestAuthenticationToken(jwt, GuestJwtCodec.parseGuest(jwt)) }
}

/** Adapter of the shared [CurrentGuestProvider] port: the only place that turns the guest principal into plain data. */
@Component
internal class SpringSecurityCurrentGuestProvider : CurrentGuestProvider {

    override suspend fun currentGuestOrNull(): CurrentGuest? =
        (ReactiveSecurityContextHolder.getContext().awaitSingleOrNull()?.authentication as? GuestAuthenticationToken)?.guest
}
