package at.dergeorg.drawboard.api.infra.web.collab

import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.web.reactive.HandlerMapping
import org.springframework.web.reactive.handler.SimpleUrlHandlerMapping
import org.springframework.web.reactive.socket.WebSocketHandler
import org.springframework.web.reactive.socket.WebSocketSession
import org.springframework.web.reactive.socket.server.support.WebSocketHandlerAdapter
import org.springframework.web.reactive.socket.server.upgrade.ReactorNettyRequestUpgradeStrategy
import reactor.core.publisher.Mono
import reactor.netty.http.server.WebsocketServerSpec

/**
 * Wires the collaboration WebSocket `/api/boards/{boardId}/collab` (docs/collab-protocol.md in the API repository).
 * It is not an OpenAPI operation and not an annotated controller: a handler mapping plus an adapter whose handshake
 * service ([CollabHandshake]) validates before the upgrade.
 *
 * Reactor Netty: frames up to 1 MiB plus the type byte and a small reserve (a larger frame closes the connection with
 * 1009 by itself), no `permessage-deflate` (S2.5: an inflated frame could be far larger than the limit).
 */
@Configuration(proxyBeanMethods = false)
internal class CollabWebSocketConfiguration {

    @Bean
    fun collabWebSocketHandlerMapping(@Value("\${api.base-path:/api}") basePath: String): HandlerMapping =
        SimpleUrlHandlerMapping(mapOf("$basePath/boards/{boardId}/collab" to PlaceholderHandler), Ordered.HIGHEST_PRECEDENCE)

    @Bean
    fun collabWebSocketHandlerAdapter(
        collab: CollabUseCase,
        properties: DrawboardProperties,
        @Value("\${collab.max-update-bytes:1048576}") maxUpdateBytes: Int,
    ): WebSocketHandlerAdapter {
        val strategy = ReactorNettyRequestUpgradeStrategy {
            WebsocketServerSpec.builder().maxFramePayloadLength(maxUpdateBytes + FRAME_RESERVE).compress(false)
        }
        return CollabHandlerAdapter(CollabHandshake(strategy, properties.origin, collab, CollabSessionBridge(collab)))
    }

    private companion object {
        /** Type byte and sequence number of a frame, plus a little more. */
        const val FRAME_RESERVE = 1024
    }
}

/**
 * Wins over Spring's own WebSocket adapter (same handler type): only this one validates the handshake. The order
 * annotation is on the class because the dispatcher sorts the adapter instances, not the bean methods.
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
internal class CollabHandlerAdapter(handshake: CollabHandshake) : WebSocketHandlerAdapter(handshake)

/** What the handler mapping resolves to; the real handler is created per admitted handshake, see [CollabHandshake]. */
private object PlaceholderHandler : WebSocketHandler {
    override fun getSubProtocols(): List<String> = listOf(CollabHandshake.PROTOCOL)

    override fun handle(session: WebSocketSession): Mono<Void> = error("the handshake service replaces this handler")
}
