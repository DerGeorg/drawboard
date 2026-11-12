package at.dergeorg.drawboard.core.infra.web

import at.dergeorg.drawboard.shared.context.ClientAddressProvider
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.reactor.ReactorContext
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * Works out the client address once per request (S7.3, see [TrustedProxies]) and puts it into the exchange attributes
 * (the WebSocket handshake reads it there) and the Reactor context (the services read it through
 * [ClientAddressProvider]). Runs right after the request-id filter, before security.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
internal class ClientAddressWebFilter(private val proxies: TrustedProxies) : WebFilter {

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        val address = resolve(exchange)
        exchange.attributes[RequestCorrelation.CLIENT_IP_KEY] = address
        return chain.filter(exchange).contextWrite { it.put(RequestCorrelation.CLIENT_IP_KEY, address) }
    }

    private fun resolve(exchange: ServerWebExchange): String {
        val peer = exchange.request.remoteAddress?.address ?: return ClientAddressProvider.UNKNOWN
        val forwarded = exchange.request.headers[FORWARDED_FOR].orEmpty()
        return proxies.clientOf(peer, forwarded).hostAddress
    }

    private companion object {
        const val FORWARDED_FOR = "X-Forwarded-For"
    }
}

/** Adapter of the shared [ClientAddressProvider] port: reads what [ClientAddressWebFilter] put into the Reactor context. */
@Component
internal class ReactiveClientAddressProvider : ClientAddressProvider {

    override suspend fun clientAddress(): String =
        currentCoroutineContext()[ReactorContext]?.context?.getOrDefault<String>(RequestCorrelation.CLIENT_IP_KEY, null)
            ?: ClientAddressProvider.UNKNOWN
}
