package at.dergeorg.drawboard.core.infra.web

import at.dergeorg.drawboard.shared.context.RequestCorrelation
import org.springframework.core.annotation.Order
import org.springframework.http.HttpHeaders
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * Runs [UploadGuard] for the three upload routes BEFORE the handler reads the multipart body (M3 backend review, MUST 1):
 * Spring spools a part to a temp file while the handler's argument is resolved, i.e. after every WebFilter - so what is
 * decided here, from the headers, costs the disk nothing.
 *
 * Order: right behind Spring Security's filter chain (order -100), so the caller is authenticated and the route table has
 * let the request through (an anonymous oversized upload is a 401, not a 413) and the principal is known. The slot of
 * an admitted upload is held until the response is done - completed, failed or cancelled (a client that hangs up).
 */
@Component
@Order(UploadGuardWebFilter.AFTER_SECURITY)
internal class UploadGuardWebFilter(private val guard: UploadGuard) : WebFilter {

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        val request = exchange.request
        val route = UploadRoute.of(request.method, request.path.pathWithinApplication().value()) ?: return chain.filter(exchange)
        val headers = request.headers
        return principalOf(exchange).flatMap { principal ->
            Mono.using(
                { guard.admit(route, principal, headers.contentLength, headers.containsHeader(HttpHeaders.TRANSFER_ENCODING)) },
                { chain.filter(exchange) },
                UploadGuard.Slot::close,
            )
        }
    }

    /** The signed-in user (issuer and subject); the client address if, against the route table, there is none. */
    private fun principalOf(exchange: ServerWebExchange): Mono<String> = ReactiveSecurityContextHolder.getContext()
        .mapNotNull { it.authentication }
        .map { (it as? JwtAuthenticationToken)?.token?.let { jwt -> "${jwt.issuer}|${jwt.subject}" } ?: it.name }
        .switchIfEmpty(Mono.fromSupplier { "ip:" + exchange.attributes[RequestCorrelation.CLIENT_IP_KEY] })

    private fun HttpHeaders.containsHeader(name: String) = !this[name].isNullOrEmpty()

    companion object {
        /** Spring Security's `WebFilterChainProxy` is at -100 (`WebFluxSecurityConfiguration.WEB_FILTER_CHAIN_FILTER_ORDER`). */
        const val AFTER_SECURITY = -99
    }
}
