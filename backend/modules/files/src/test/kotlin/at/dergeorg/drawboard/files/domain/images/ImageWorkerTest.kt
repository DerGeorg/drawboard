package at.dergeorg.drawboard.files.domain.images

import at.dergeorg.drawboard.files.domain.files.BytesChannel
import at.dergeorg.drawboard.files.domain.files.Samples
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer
import java.nio.channels.SeekableByteChannel
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

class ImageWorkerTest {

    private val workers = mutableListOf<ImageWorker>()

    private fun worker(threads: Int, decode: (javax.imageio.stream.ImageInputStream, String) -> Thumbnail? = ImageThumbnails::create) =
        ImageWorker(threads, 30.seconds, decode).also { workers += it }

    @AfterEach
    fun close() = workers.forEach { it.close() }

    /** A channel over [bytes] that remembers the biggest single read asked of it and whether it was closed. */
    private class WatchedChannel(bytes: ByteArray) : SeekableByteChannel {
        private val inner = BytesChannel(bytes)
        var biggestRead = 0
        var bytesRead = 0L
        var closed = false

        override fun read(dst: ByteBuffer): Int {
            biggestRead = maxOf(biggestRead, dst.remaining())
            return inner.read(dst).also { if (it > 0) bytesRead += it }
        }

        override fun write(src: ByteBuffer): Int = throw UnsupportedOperationException()
        override fun position() = inner.position()
        override fun position(newPosition: Long) = apply { inner.position(newPosition) }
        override fun size() = inner.size()
        override fun truncate(size: Long) = throw UnsupportedOperationException()
        override fun isOpen() = !closed
        override fun close() {
            closed = true
            inner.close()
        }
    }

    @Nested
    inner class Reading {

        @Test
        fun `when a big image is thumbnailed then the stored file is read through the channel in pieces, never as a whole`() = runBlocking {
            val jpeg = Samples.noisyJpeg(1500, 1000)
            val channel = WatchedChannel(jpeg)

            val thumbnail = worker(1).thumbnail("image/jpeg") { channel }

            assertNotNull(thumbnail, "decodes")
            assertTrue(jpeg.size > 3 * ChannelImageInputStream.CHUNK, "the sample is much bigger than a chunk: ${jpeg.size}")
            assertTrue(channel.biggestRead <= ChannelImageInputStream.CHUNK, "no read asked for more than a chunk: ${channel.biggestRead}")
            assertTrue(channel.bytesRead > 0, "it was read")
            assertTrue(channel.closed, "the channel is closed afterwards")
        }

        @Test
        fun `when there is no stored blob or the bytes are no image then there is no thumbnail and no exception`() = runBlocking {
            val worker = worker(1)

            assertNull(worker.thumbnail("image/png") { null }, "no blob")
            assertNull(worker.thumbnail("image/png") { WatchedChannel(ByteArray(50)) }, "noise")
            assertEquals(0, worker.inWork, "the permit is back after both")
        }

        @Test
        fun `when the stream is read and sought then it serves the bytes at the position asked for`() {
            val bytes = ByteArray(200_000) { (it % 251).toByte() }
            val stream = ChannelImageInputStream(WatchedChannel(bytes))

            stream.seek(150_000)
            val tail = ByteArray(5)
            stream.readFully(tail)
            stream.seek(10)
            val first = stream.read()

            assertEquals(List(5) { ((150_000 + it) % 251).toByte() }, tail.toList(), "seek forward and read")
            assertEquals(10 % 251, first, "seek back and read one byte")
            assertEquals(200_000L, stream.length(), "length is the size of the blob")
            stream.close()
        }
    }

    @Nested
    inner class Concurrency {

        @Test
        fun `when more images arrive than decoder threads then no more than the threads read and decode at once`() = runBlocking {
            val threads = 2
            val running = AtomicInteger()
            val highest = AtomicInteger()
            val entered = AtomicInteger()
            val gate = CountDownLatch(1)
            val worker = worker(threads) { _, _ ->
                highest.accumulateAndGet(running.incrementAndGet(), ::maxOf)
                entered.incrementAndGet()
                check(gate.await(10, TimeUnit.SECONDS)) { "test gate never opened" }
                running.decrementAndGet()
                Thumbnail("image/jpeg", ByteArray(1))
            }
            val opened = AtomicInteger()

            val results = (1..6).map {
                async(Dispatchers.Default) {
                    worker.thumbnail("image/jpeg") {
                        opened.incrementAndGet()
                        BytesChannel(ByteArray(1))
                    }
                }
            }
            awaitCount(entered, threads)
            Thread.sleep(SETTLE_MILLIS) // the other four would have started by now if the bound did not hold

            assertEquals(threads, entered.get(), "only the free decoders took an image")
            assertEquals(threads, opened.get(), "and only they read the stored file: nothing else was opened, let alone buffered")
            assertEquals(threads, worker.inWork, "the permits are all in use")
            gate.countDown()
            val done = results.awaitAll()

            assertTrue(done.all { it != null }, "all six are made in the end")
            assertEquals(threads, highest.get(), "never more than the decoder threads at once")
            assertEquals(0, worker.inWork, "every permit is back")
        }

        @Test
        fun `when a decode runs past the time limit then the caller is freed but the permit stays with the running decode`() = runBlocking {
            val gate = CountDownLatch(1)
            val started = AtomicInteger()
            val worker = ImageWorker(1, 1.seconds) { _, _ ->
                started.incrementAndGet()
                gate.await(10, TimeUnit.SECONDS)
                null
            }.also { workers += it }

            val first = worker.thumbnail("image/jpeg") { BytesChannel(ByteArray(1)) }

            assertNull(first, "timed out: the upload goes on without a thumbnail")
            assertEquals(1, worker.inWork, "the thread is still busy, so its permit is still taken")
            gate.countDown()
            awaitCount(started, 1)
            val deadline = System.nanoTime() + WAIT_NANOS
            while (worker.inWork != 0 && System.nanoTime() < deadline) Thread.sleep(POLL_MILLIS)
            assertEquals(0, worker.inWork, "released when the decode really ended")
        }

        private fun awaitCount(counter: AtomicInteger, expected: Int) {
            val deadline = System.nanoTime() + WAIT_NANOS
            while (counter.get() < expected && System.nanoTime() < deadline) Thread.sleep(POLL_MILLIS)
            assertTrue(counter.get() >= expected, "waited for $expected, got ${counter.get()}")
        }
    }

    private companion object {
        const val SETTLE_MILLIS = 300L
        const val POLL_MILLIS = 10L
        const val WAIT_NANOS = 10_000_000_000L
    }
}
