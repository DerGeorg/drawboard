package at.dergeorg.drawboard.files.domain.files.requires.impl

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.EOFException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * A clamd for tests: listens on a free port of the loopback address and speaks just enough of the protocol - the command
 * `zINSTREAM\0`, then chunks of a 4-byte big-endian length and data up to a chunk of length 0. What it received is kept; what
 * it answers is chosen by [behavior].
 */
class FakeClamd(private val behavior: Behavior = Behavior.Answer("stream: OK")) : Closeable {

    /** What the fake does once it has the whole stream. */
    sealed interface Behavior {
        /** Answers [text] terminated by NUL, as clamd does for `z` commands. */
        data class Answer(val text: String) : Behavior

        /** Reads the stream and then says nothing and keeps the connection open: a clamd that hangs. */
        data object Hang : Behavior

        /** Closes the connection as soon as it has the command. */
        data object HangUpAtOnce : Behavior
    }

    private val server = ServerSocket(0, 10, InetAddress.getLoopbackAddress())
    private val open = CopyOnWriteArrayList<Socket>()
    val port: Int get() = server.localPort

    val connections = AtomicInteger()
    val commands = CopyOnWriteArrayList<String>()
    val streams = CopyOnWriteArrayList<ByteArray>()
    val chunkSizes = CopyOnWriteArrayList<Int>()

    init {
        thread(isDaemon = true, name = "fake-clamd") {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: java.io.IOException) {
                    break
                }
                connections.incrementAndGet()
                open += socket
                thread(isDaemon = true) { serve(socket) }
            }
        }
    }

    private fun serve(socket: Socket) {
        try {
            val input = DataInputStream(socket.getInputStream())
            val command = ByteArrayOutputStream()
            while (true) {
                val next = input.read()
                if (next < 0) return
                if (next == 0) break
                command.write(next)
            }
            commands += command.toString(Charsets.US_ASCII)
            if (behavior is Behavior.HangUpAtOnce) return
            val payload = ByteArrayOutputStream()
            while (true) {
                val length = try {
                    input.readInt()
                } catch (_: EOFException) {
                    return
                }
                if (length == 0) break
                chunkSizes += length
                payload.write(input.readNBytes(length))
            }
            streams += payload.toByteArray()
            when (behavior) {
                is Behavior.Answer -> socket.getOutputStream().apply {
                    write((behavior.text + "\u0000").toByteArray(Charsets.US_ASCII))
                    flush()
                }
                else -> Thread.sleep(HANG_MILLIS)
            }
        } catch (_: java.io.IOException) {
            // the client went away - a test of the client's timeout does that
        } finally {
            socket.close()
        }
    }

    override fun close() {
        server.close()
        open.forEach { it.close() }
    }

    private companion object {
        const val HANG_MILLIS = 60_000L
    }
}
