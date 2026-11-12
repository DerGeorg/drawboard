package at.dergeorg.drawboard.files.domain.images

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.nio.channels.SeekableByteChannel
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import javax.imageio.stream.ImageInputStream
import kotlin.time.Duration

/**
 * The pool images are decoded in (S4.8): a few threads of its own, so a flood of uploads cannot take the threads of the
 * web server, and a time limit per image.
 *
 * Memory is bounded twice (M3 backend review, MUST 2). The image is read from the stored blob THROUGH a channel by the
 * decoder itself, in pieces, on the decoder's thread - the original never sits in the heap as a whole. And the whole of
 * read plus decode holds one of [threads] permits, released by the task itself when it really ends, so even after a timeout
 * (a thread cannot be interrupted inside the JDK decoder) no more than [threads] images are in work. What waits for a permit
 * is a suspended coroutine, not an image.
 */
internal class ImageWorker(
    private val threads: Int,
    private val timeout: Duration,
    private val decode: (ImageInputStream, String) -> Thumbnail? = ImageThumbnails::create,
) : AutoCloseable {

    private val executor: ExecutorService = Executors.newFixedThreadPool(
        threads,
        ThreadFactory { task -> Thread(task, "image-decoder").apply { isDaemon = true } },
    )
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
    private val permits = Semaphore(threads)

    /** How many images are being read and decoded right now (at most [threads]). */
    val inWork: Int get() = threads - permits.availablePermits

    /**
     * The thumbnail of the image [open] gives a channel to, or null when there is no such blob, the image cannot be decoded or
     * it did not finish within the time limit (counted from the moment a decoder is free, not from the call).
     */
    suspend fun thumbnail(mediaType: String, open: () -> SeekableByteChannel?): Thumbnail? {
        permits.acquire()
        // await() is cancellable, the decoder is not: the timeout frees the caller, the task finishes on its own thread
        val work = scope.async {
            try {
                open()?.let { ChannelImageInputStream(it).use { input -> decode(input, mediaType) } }
            } finally {
                permits.release()
            }
        }
        // the limit is real time whatever dispatcher the caller runs on (a test dispatcher would skip the wait)
        return withContext(Dispatchers.Default) { withTimeoutOrNull(timeout) { work.await() } }
    }

    override fun close() {
        executor.shutdown()
    }
}
