package at.dergeorg.drawboard.integration.files

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.EOFException
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/** The marker of the EICAR test file: the fake clamd below calls everything that contains it infected. */
const val EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*"

/**
 * A clamd for the integration tests: speaks the `zINSTREAM` protocol on a loopback port and answers `stream: OK`, or
 * `stream: Win.Test.EICAR_HDB-1 FOUND` for a stream that contains [EICAR]. [stop] closes the port, so the next scan finds nobody.
 */
class FakeClamdServer : Closeable {

    private val server = ServerSocket(0, 10, InetAddress.getLoopbackAddress())
    val port: Int get() = server.localPort
    val streams = CopyOnWriteArrayList<ByteArray>()

    init {
        thread(isDaemon = true, name = "fake-clamd-it") {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                thread(isDaemon = true) { serve(socket) }
            }
        }
    }

    private fun serve(socket: Socket) {
        socket.use { answer(it) }
    }

    private fun answer(socket: Socket) {
        try {
            val input = DataInputStream(socket.getInputStream())
            while (input.read().let { next -> next > 0 }) { /* the command, up to its NUL */ }
            val payload = ByteArrayOutputStream()
            while (true) {
                val length = try {
                    input.readInt()
                } catch (_: EOFException) {
                    return
                }
                if (length == 0) break
                payload.write(input.readNBytes(length))
            }
            val bytes = payload.toByteArray()
            streams += bytes
            val answer = if (String(bytes, Charsets.ISO_8859_1).contains(EICAR)) "stream: Win.Test.EICAR_HDB-1 FOUND" else "stream: OK"
            socket.getOutputStream().apply { write((answer + "\u0000").toByteArray()); flush() }
        } catch (_: IOException) {
            // the client went away
        }
    }

    fun stop() = server.close()

    override fun close() = stop()
}
