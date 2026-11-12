package at.dergeorg.drawboard.api.infra.web.collab

import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabConnection
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactor.asFlux
import kotlinx.coroutines.reactor.mono
import kotlinx.coroutines.flow.consumeAsFlow
import org.springframework.web.reactive.socket.CloseStatus
import org.springframework.web.reactive.socket.WebSocketMessage
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono

/**
 * Connects one Spring [WebSocketSession] with the [CollabConnection] of the collab module: frames out, messages in,
 * and the close the module orders. Nothing else - what the frames mean is the business of collab.
 */
internal class CollabSessionBridge(private val collab: CollabUseCase) {

    fun run(session: WebSocketSession, admitted: Admission.Admitted): Mono<Void> = Mono.usingWhen(
        mono { collab.open(admitted) },
        { connection -> exchange(session, connection) },
        { connection -> mono { connection.disconnected() }.then() },
    )

    private fun exchange(session: WebSocketSession, connection: CollabConnection): Mono<Void> {
        val output = session
            .send(connection.frames.consumeAsFlow().map { bytes -> session.binaryMessage { it.wrap(bytes) } }.asFlux())
            .then(Mono.defer { session.close(statusOf(connection)) })
        val input = session.receive()
            .map { message -> message.type to message.payload.let { ByteArray(it.readableByteCount()).also(it::read) } }
            .concatMap { (type, bytes) ->
                mono {
                    if (type == WebSocketMessage.Type.BINARY) connection.onBinary(bytes) else connection.onText()
                }
            }
            .then()
        // Whichever ends first ends the other: the client left, or the server ordered the close.
        return Mono.firstWithSignal(output, input).onErrorResume { Mono.empty() }
    }

    private fun statusOf(connection: CollabConnection): CloseStatus =
        connection.closeOrder?.let { CloseStatus(it.code, it.reason) } ?: CloseStatus.NORMAL
}
