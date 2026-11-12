package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.requires.ScanVerdict
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.net.ServerSocket
import java.nio.channels.Channels
import java.nio.channels.ReadableByteChannel
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ClamavFileScannerTest {

    private val servers = mutableListOf<FakeClamd>()

    @AfterEach
    fun stop() = servers.forEach(FakeClamd::close)

    private fun clamd(behavior: FakeClamd.Behavior = FakeClamd.Behavior.Answer("stream: OK")) = FakeClamd(behavior).also { servers += it }

    private fun scanner(port: Int, timeoutSeconds: Long = 5, maxBytes: Long = 1_000_000) =
        ClamavFileScanner("127.0.0.1", port, connectTimeoutSeconds = 1, timeoutSeconds = timeoutSeconds, maxBytes = maxBytes)

    private fun channel(bytes: ByteArray): ReadableByteChannel = Channels.newChannel(bytes.inputStream())

    private fun scan(scanner: ClamavFileScanner, bytes: ByteArray, declared: Long = bytes.size.toLong()) =
        runBlocking { scanner.scan(channel(bytes), declared) }

    @Nested
    inner class Protocol {

        @Test
        fun `when clamd says OK then the file is clean, and clamd got zINSTREAM, the bytes and the closing zero chunk`() {
            val fake = clamd()
            val bytes = "some file content".toByteArray()

            val verdict = scan(scanner(fake.port), bytes)

            assertEquals(ScanVerdict.Clean, verdict, "OK is clean")
            assertEquals(listOf("zINSTREAM"), fake.commands.toList(), "the command")
            assertTrue(bytes.contentEquals(fake.streams.single()), "the bytes arrived unchanged")
            assertEquals(listOf(bytes.size), fake.chunkSizes.toList(), "one chunk")
        }

        @Test
        fun `when the file is larger than a chunk then it arrives in chunks and unchanged`() {
            val fake = clamd()
            val bytes = ByteArray(200_000) { (it % 251).toByte() }

            val verdict = scan(scanner(fake.port), bytes)

            assertEquals(ScanVerdict.Clean, verdict, "clean")
            assertTrue(fake.chunkSizes.size >= 4, "200 kB are at least four chunks of 64 kB, was ${fake.chunkSizes}")
            assertTrue(bytes.contentEquals(fake.streams.single()), "reassembled to the original")
        }

        @Test
        fun `when clamd reports a signature then the file is infected with the name`() {
            val fake = clamd(FakeClamd.Behavior.Answer("stream: Win.Test.EICAR_HDB-1 FOUND"))

            val verdict = scan(scanner(fake.port), "X5O!P%@AP".toByteArray())

            assertEquals(ScanVerdict.Infected("Win.Test.EICAR_HDB-1"), verdict, "FOUND is infected")
        }

        @Test
        fun `when the signature name has odd characters then only printable ones of a fixed set stay, cut at 100`() {
            val fake = clamd(FakeClamd.Behavior.Answer("stream: Bad\u0001<script>\"x\" " + "a".repeat(200) + " FOUND"))

            val verdict = scan(scanner(fake.port), byteArrayOf(1))

            val signature = (verdict as ScanVerdict.Infected).signature
            assertTrue(signature.startsWith("Badscriptx a") && signature.length == 100, "sanitised and cut: $signature")
        }

        @Test
        fun `when clamd answers with an error then it could not be scanned, whatever the text says`() {
            val fake = clamd(FakeClamd.Behavior.Answer("INSTREAM size limit exceeded. ERROR"))

            val verdict = scan(scanner(fake.port), byteArrayOf(1, 2, 3))

            assertEquals(ScanVerdict.Unavailable("ERROR_RESPONSE"), verdict, "an error is unavailable")
        }

        @Test
        fun `when the answer is something unknown then it could not be scanned`() {
            val fake = clamd(FakeClamd.Behavior.Answer("PONG"))

            assertEquals(ScanVerdict.Unavailable("ERROR_RESPONSE"), scan(scanner(fake.port), byteArrayOf(1)), "unknown answer")
        }
    }

    @Nested
    inner class Limits {

        @Test
        fun `when the file is larger than the limit then clamd is not even asked`() {
            val fake = clamd()

            val verdict = scan(scanner(fake.port, maxBytes = 10), ByteArray(11))

            assertEquals(ScanVerdict.TooLarge(10), verdict, "over the limit, named with the limit")
            assertEquals(0, fake.connections.get(), "no connection was made")
        }

        @Test
        fun `when the file is exactly as large as the limit then it is scanned`() {
            val fake = clamd()

            assertEquals(ScanVerdict.Clean, scan(scanner(fake.port, maxBytes = 10), ByteArray(10)), "at the limit")
        }

        @Test
        fun `when the stored file turns out larger than its size says then the scan stops as too large`() {
            val fake = clamd()

            val verdict = scan(scanner(fake.port, maxBytes = 100), ByteArray(500), declared = 50)

            assertEquals(ScanVerdict.TooLarge(100), verdict, "more bytes than the limit, whatever was declared")
        }
    }

    @Nested
    inner class Failures {

        @Test
        fun `when nobody listens on the port then it could not be scanned`() {
            val closed = ServerSocket(0).use { it.localPort }

            assertEquals(ScanVerdict.Unavailable("IO"), scan(scanner(closed), byteArrayOf(1)), "connection refused")
        }

        @Test
        fun `when clamd hangs up at once then it could not be scanned`() {
            val fake = clamd(FakeClamd.Behavior.HangUpAtOnce)

            // below the 1 MB limit: over it, the size check could answer TooLarge before the
            // dead connection is noticed (socket buffers absorb the first megabyte on a fast host)
            val verdict = scan(scanner(fake.port), ByteArray(500_000), declared = 1)

            assertTrue(verdict is ScanVerdict.Unavailable, "the connection died: $verdict")
        }

        @Test
        fun `when clamd never answers then the scan ends after the timeout, not after a minute`() {
            val fake = clamd(FakeClamd.Behavior.Hang)
            val started = System.nanoTime()

            val verdict = scan(scanner(fake.port, timeoutSeconds = 1), byteArrayOf(1, 2, 3))

            val seconds = (System.nanoTime() - started) / 1_000_000_000.0
            assertEquals(ScanVerdict.Unavailable("IO"), verdict, "a timeout is unavailable")
            assertTrue(seconds < 10, "the watchdog closed the socket after about a second, took $seconds s")
        }
    }
}
