package at.dergeorg.drawboard.core.infra.security

import at.dergeorg.drawboard.shared.context.CurrentUser
import at.dergeorg.drawboard.shared.context.CurrentUserProvider
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Component

/** Adapter of the shared [CurrentUserProvider] port: the only place that turns Spring Security types into [CurrentUser]. */
@Component
internal class SpringSecurityCurrentUserProvider(properties: OidcProperties) : CurrentUserProvider {

    private val mapper = JwtCurrentUserMapper(properties)

    override suspend fun currentUserOrNull(): CurrentUser? {
        val token = ReactiveSecurityContextHolder.getContext().awaitSingleOrNull()?.authentication as? JwtAuthenticationToken
            ?: return null
        return mapper.map(token.token)
    }
}
