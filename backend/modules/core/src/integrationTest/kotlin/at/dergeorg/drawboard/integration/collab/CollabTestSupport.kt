// Signed test tokens carry java.time claims (exp); the Nimbus API takes java.util.Date. The one place that cannot use kotlin.time.
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.integration.collab

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.reactor.asFlux
import kotlinx.coroutines.withTimeout
import org.springframework.http.HttpHeaders
import org.springframework.web.reactive.socket.CloseStatus
import org.springframework.web.reactive.socket.WebSocketHandler
import org.springframework.web.reactive.socket.WebSocketSession
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient
import reactor.core.publisher.Mono
import java.net.InetSocketAddress
import java.net.URI
import java.util.Date
import kotlin.time.Duration.Companion.seconds

const val COLLAB_ISSUER = "https://idp.example.test/realms/drawboard"
const val PUBLIC_URL = "http://localhost:4200"

/** Tokens signed with a key whose JWKS a local HTTP server serves - the application validates them for real. */
object SignedTokens {
    private val key: RSAKey = RSAKeyGenerator(2048).keyID("collab-test-key").generate()
    private val jwks: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/jwks") { exchange ->
            val body = JWKSet(key.toPublicJWK()).toString().toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        start()
        Runtime.getRuntime().addShutdownHook(Thread { stop(0) })
    }

    val jwkSetUri: String get() = "http://127.0.0.1:${jwks.address.port}/jwks"

    fun token(subject: String, name: String, expiresInSeconds: Long = 600, groups: List<String> = emptyList()): String {
        val claims = JWTClaimsSet.Builder()
            .issuer(COLLAB_ISSUER).subject(subject).audience("drawboard-api")
            .expirationTime(Date(System.currentTimeMillis() + expiresInSeconds * 1000))
            .claim("preferred_username", name.lowercase()).claim("name", name)
            .apply { if (groups.isNotEmpty()) claim("groups", groups) }.build()
        return SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(key.keyID).build(), claims)
            .apply { sign(RSASSASigner(key)) }.serialize()
    }
}

/** One side of a collaboration WebSocket, seen from the test: what arrived, what to send, how it ended. */
class TestSocket private constructor() {
    private val received = Channel<ByteArray>(Channel.UNLIMITED)
    private val toSend = Channel<ByteArray>(Channel.UNLIMITED)
    private val closed = CompletableDeferred<CloseStatus>()

    suspend fun send(vararg bytes: Int) = toSend.send(ByteArray(bytes.size) { bytes[it].toByte() })

    suspend fun send(frame: ByteArray) = toSend.send(frame)

    /** The next frame the server sent. */
    suspend fun next(): ServerFrame = ServerFrame(withTimeout(TIMEOUT) { received.receive() })

    /** Frames up to and including the first one of [type]. */
    suspend fun until(type: Int): List<ServerFrame> = buildList {
        do add(next()) while (last().type != type)
    }

    suspend fun closeStatus(): CloseStatus = withTimeout(TIMEOUT) { closed.await() }

    companion object {
        private val TIMEOUT = 15.seconds

        /** Connects with the subprotocols `drawboard.v1` and `ticket.<ticket>` and the given Origin. */
        fun connect(port: Int, boardId: String, ticket: String, origin: String = PUBLIC_URL): TestSocket {
            val socket = TestSocket()
            val handler = object : WebSocketHandler {
                override fun getSubProtocols() = listOf("drawboard.v1", "ticket.$ticket")

                override fun handle(session: WebSocketSession): Mono<Void> {
                    session.closeStatus().subscribe { socket.closed.complete(it) }
                    val out = session.send(socket.toSend.consumeAsFlow().map { b -> session.binaryMessage { it.wrap(b) } }.asFlux())
                    val `in` = session.receive()
                        .doOnNext { m -> socket.received.trySend(ByteArray(m.payload.readableByteCount()).also(m.payload::read)) }
                        .then()
                    return Mono.firstWithSignal(out, `in`)
                }
            }
            val headers = HttpHeaders().apply { set(HttpHeaders.ORIGIN, origin) }
            ReactorNettyWebSocketClient()
                .execute(URI("ws://localhost:$port/api/boards/$boardId/collab"), headers, handler)
                .subscribe({ }, { socket.closed.completeExceptionally(it) })
            return socket
        }
    }
}

/** A server frame: type byte, then lib0 encodings. */
class ServerFrame(val bytes: ByteArray) {
    val type: Int = bytes[0].toInt() and 0xff
    private var position = 1

    fun varUint(): Long {
        var value = 0L
        var shift = 0
        while (true) {
            val b = bytes[position++].toInt() and 0xff
            value = value or ((b and 0x7f).toLong() shl shift)
            if (b < 0x80) return value
            shift += 7
        }
    }

    fun varString(): String {
        val length = varUint().toInt()
        return String(bytes, position, length, Charsets.UTF_8).also { position += length }
    }

    fun rest(): ByteArray = bytes.copyOfRange(position, bytes.size)

    companion object {
        const val WELCOME = 0x80
        const val SNAPSHOT = 0x81
        const val UPDATE = 0x82
        const val SYNCED = 0x83
        const val ACK = 0x84
        const val AWARENESS = 0x85
        const val PEER_JOINED = 0x86
        const val PEER_LEFT = 0x87
        const val COMPACT = 0x88
        const val PONG = 0x89
        const val ROLE = 0x8A
    }
}
