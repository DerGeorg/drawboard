package at.dergeorg.drawboard.api.infra.web.collab

import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.model.RejectionReason
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import kotlinx.coroutines.reactor.mono
import org.springframework.http.HttpHeaders
import org.springframework.web.reactive.socket.WebSocketHandler
import org.springframework.web.reactive.socket.WebSocketSession
import org.springframework.web.reactive.socket.server.RequestUpgradeStrategy
import org.springframework.web.reactive.socket.server.support.HandshakeWebSocketService
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import kotlin.uuid.Uuid

/**
 * The handshake of the collaboration WebSocket (S2.1, S2.2): everything is checked BEFORE the upgrade, so a refused
 * handshake is an ordinary HTTP error and no WebSocket ever exists for it.
 *
 * 1. the subprotocol header contains `drawboard.v1` and exactly one `ticket.<t>`, else 400;
 * 2. `Origin` equals the configured public URL exactly, else 403;
 * 3. the ticket is redeemed (single use) for this board, else 401; the user's role is resolved again, none: 404;
 *    session limits: 429.
 *
 * Only then it upgrades, answering with the subprotocol `drawboard.v1` and nothing else (the ticket never comes
 * back). The header `Sec-WebSocket-Protocol` carries a credential: it is read here and nowhere logged (S7.2).
 */
internal class CollabHandshake(
    upgradeStrategy: RequestUpgradeStrategy,
    private val publicOrigin: String,
    private val collab: CollabUseCase,
    private val sessions: CollabSessionBridge,
) : HandshakeWebSocketService(upgradeStrategy) {

    override fun handleRequest(exchange: ServerWebExchange, handler: WebSocketHandler): Mono<Void> =
        mono { admit(exchange) }.flatMap { admitted ->
            super.handleRequest(exchange, AdmittedHandler(sessions, admitted))
        }

    private suspend fun admit(exchange: ServerWebExchange): Admission.Admitted {
        val ticket = ticketOf(exchange.request.headers)
        if (exchange.request.headers.origin != publicOrigin) throw DomainException(ErrorCode.FORBIDDEN)
        val boardId = boardIdOf(exchange)
        val address = exchange.attributes[RequestCorrelation.CLIENT_IP_KEY] as? String
        return when (val admission = collab.admit(ticket, boardId, address)) {
            is Admission.Admitted -> admission
            is Admission.Rejected -> throw when (admission.reason) {
                RejectionReason.UNKNOWN_TICKET -> DomainException(ErrorCode.UNAUTHORIZED)
                RejectionReason.NO_ACCESS -> DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))
                RejectionReason.TOO_MANY_SESSIONS -> RateLimitedException(retryAfterSeconds = RETRY_AFTER_SECONDS)
                RejectionReason.BOARD_BUSY -> RateLimitedException(retryAfterSeconds = BUSY_RETRY_SECONDS)
            }
        }
    }

    /** The ticket from the subprotocols; `drawboard.v1` must be offered next to it. */
    private fun ticketOf(headers: HttpHeaders): String {
        val offered = headers[SUBPROTOCOL_HEADER].orEmpty().flatMap { it.split(',') }.map { it.trim() }
        val tickets = offered.filter { it.startsWith(TICKET_PREFIX) }
        if (PROTOCOL !in offered || tickets.size != 1) throw DomainException(ErrorCode.MALFORMED_REQUEST)
        return tickets.single().removePrefix(TICKET_PREFIX)
    }

    private fun boardIdOf(exchange: ServerWebExchange): Uuid {
        val segment = exchange.request.path.pathWithinApplication().value().trim('/').split('/').getOrNull(BOARD_ID_SEGMENT)
        return segment?.let { runCatching { Uuid.parse(it) }.getOrNull() } ?: throw DomainException(ErrorCode.MALFORMED_REQUEST)
    }

    /** The handler of one admitted handshake: knows who was admitted and answers `drawboard.v1` only. */
    private class AdmittedHandler(private val sessions: CollabSessionBridge, private val admitted: Admission.Admitted) : WebSocketHandler {

        override fun getSubProtocols(): List<String> = listOf(PROTOCOL)

        override fun handle(session: WebSocketSession): Mono<Void> = sessions.run(session, admitted)
    }

    companion object {
        const val PROTOCOL = "drawboard.v1"
        private const val SUBPROTOCOL_HEADER = "Sec-WebSocket-Protocol"
        private const val TICKET_PREFIX = "ticket."
        private const val RETRY_AFTER_SECONDS = 30L
        private const val BUSY_RETRY_SECONDS = 2L

        /** `/api/boards/{boardId}/collab` - the segment after "boards" (the base path may differ in length). */
        private const val BOARD_ID_SEGMENT = 2
    }
}
