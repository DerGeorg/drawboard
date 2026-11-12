package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.requires.FileScanner
import at.dergeorg.drawboard.files.domain.files.requires.ScanVerdict
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression
import org.springframework.stereotype.Component
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.channels.ReadableByteChannel
import kotlin.time.Duration.Companion.seconds

/**
 * The ClamAV adapter (S4.12): the clamd protocol `zINSTREAM` over TCP. The command, then the bytes in chunks of a 4-byte
 * big-endian length and the data, then a chunk of length 0; clamd answers `stream: OK`, `stream: <name> FOUND` or `... ERROR`.
 * Nothing the user controls reaches clamd except the bytes of the file. Bounded: the connect time, the whole scan (a watchdog
 * closes the socket, which ends a blocked read or write at once) and the size - a file larger than [maxBytes] is not sent at
 * all (clamd would refuse it anyway, `StreamMaxLength`) and answers [ScanVerdict.TooLarge], which is not a scanner failure.
 */
@Component
@ConditionalOnExpression("'\${files.clamav-host:}'.trim() != ''")
internal class ClamavFileScanner(
    @Value("\${files.clamav-host}") private val host: String,
    @Value("\${files.clamav-port:3310}") private val port: Int,
    @Value("\${files.clamav-connect-timeout-seconds:3}") connectTimeoutSeconds: Long,
    @Value("\${files.clamav-timeout-seconds:60}") timeoutSeconds: Long,
    @Value("\${files.clamav-max-bytes:26214400}") private val maxBytes: Long,
) : FileScanner {

    private val connectTimeoutMillis = connectTimeoutSeconds.seconds.inWholeMilliseconds.toInt()
    private val timeout = timeoutSeconds.seconds

    @WithSpan
    override suspend fun scan(content: ReadableByteChannel, size: Long): ScanVerdict {
        if (size > maxBytes) return ScanVerdict.TooLarge(maxBytes)
        return try {
            withContext(Dispatchers.IO) { instream(content) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            ScanVerdict.Unavailable("IO")
        } catch (@Suppress("TooGenericExceptionCaught") _: Exception) {
            ScanVerdict.Unavailable("ERROR")
        }
    }

    private suspend fun instream(content: ReadableByteChannel): ScanVerdict = coroutineScope {
        val socket = Socket()
        // closing the socket is the only way to end a blocked read or write: the watchdog does it when the whole scan took too long
        val watchdog = launch {
            delay(timeout)
            socket.close()
        }
        try {
            socket.connect(InetSocketAddress(host, port), connectTimeoutMillis)
            socket.tcpNoDelay = true
            socket.soTimeout = timeout.inWholeMilliseconds.toInt()
            send(socket, content) ?: parse(answer(socket))
        } finally {
            watchdog.cancel()
            socket.close()
        }
    }

    /** Sends the command and the chunks; null when everything was sent, else the verdict that stops the scan. */
    private fun send(socket: Socket, content: ReadableByteChannel): ScanVerdict? {
        val out = BufferedOutputStream(socket.getOutputStream(), CHUNK_BYTES + LENGTH_BYTES)
        out.write(COMMAND)
        val buffer = ByteBuffer.allocate(CHUNK_BYTES)
        var sent = 0L
        while (true) {
            buffer.clear()
            val read = content.read(buffer)
            if (read < 0) break
            sent += read
            if (sent > maxBytes) return ScanVerdict.TooLarge(maxBytes) // the stored file is larger than it said
            if (read > 0) {
                out.write(length(read))
                out.write(buffer.array(), 0, read)
            }
        }
        out.write(length(0))
        out.flush()
        return null
    }

    /** The answer up to the terminating NUL (or the end of the stream), at most [MAX_ANSWER] bytes. */
    private fun answer(socket: Socket): String {
        val input = socket.getInputStream()
        val bytes = ByteArray(MAX_ANSWER)
        var length = 0
        while (length < MAX_ANSWER) {
            val next = input.read()
            if (next < 0 || next == 0) break
            bytes[length++] = next.toByte()
        }
        return String(bytes, 0, length, Charsets.US_ASCII).trim()
    }

    private fun parse(answer: String): ScanVerdict = when {
        answer.endsWith(FOUND) -> ScanVerdict.Infected(signature(answer.removeSuffix(FOUND).removePrefix(STREAM_PREFIX)))
        answer.endsWith(OK) -> ScanVerdict.Clean
        else -> ScanVerdict.Unavailable("ERROR_RESPONSE") // the text of an error may quote the file: never kept
    }

    /** The signature name is printable ASCII of a fixed set and cut: it ends up in the audit trail. */
    private fun signature(raw: String): String = raw.trim().filter { it.isLetterOrDigit() || it in "._-:/ " }.take(MAX_SIGNATURE)

    private fun length(value: Int): ByteArray =
        ByteBuffer.allocate(LENGTH_BYTES).putInt(value).array() // big-endian, as clamd wants it

    private companion object {
        val COMMAND = "zINSTREAM\u0000".toByteArray(Charsets.US_ASCII)
        const val CHUNK_BYTES = 64 * 1024
        const val LENGTH_BYTES = 4
        const val MAX_ANSWER = 1024
        const val MAX_SIGNATURE = 100
        const val STREAM_PREFIX = "stream:"
        const val FOUND = " FOUND"
        const val OK = "OK"
    }
}

/** The scanner of a deployment without ClamAV: scans nothing, finds nothing. */
@Component
@ConditionalOnExpression("'\${files.clamav-host:}'.trim() == ''")
internal class NoOpFileScanner : FileScanner {

    override val enabled: Boolean get() = false

    override suspend fun scan(content: ReadableByteChannel, size: Long): ScanVerdict = ScanVerdict.Clean
}
