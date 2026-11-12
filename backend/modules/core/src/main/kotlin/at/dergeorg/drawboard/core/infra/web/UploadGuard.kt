package at.dergeorg.drawboard.core.infra.web

import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.server.PathContainer
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.util.pattern.PathPattern
import org.springframework.web.util.pattern.PathPatternParser
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes

/** The three routes whose multipart body Spring would spool to disk before the handler runs. */
internal enum class UploadRoute(val method: HttpMethod, path: String) {
    FILE(HttpMethod.POST, "/api/boards/*/files"), // uploadFile
    SNAPSHOT(HttpMethod.PUT, "/api/boards/*/snapshot"), // uploadBoardSnapshot
    PLUGIN(HttpMethod.POST, "/api/admin/plugins"), // installPlugin
    ;

    private val pattern: PathPattern = PathPatternParser.defaultInstance.parse(path)

    fun matches(method: HttpMethod, path: String): Boolean = method == this.method && pattern.matches(PathContainer.parsePath(path))

    companion object {
        fun of(method: HttpMethod, path: String): UploadRoute? = entries.firstOrNull { it.matches(method, path) }
    }
}

/**
 * Decides, from the request headers alone, whether an upload may even start (M3 backend review, MUST 1): `Content-Length` must
 * be there (411) and within the cap of the route (413), the user must be under the start rate (429) and the number of uploads
 * in flight, her own and the instance's (429). Whatever it lets in holds a [Slot] until the response is done.
 * The decisions are made before the multipart reader sees a byte, so a refused request spools nothing.
 */
internal class UploadGuard(private val limits: UploadProperties, clock: Clock) {

    private val started = UploadRoute.entries.associateWith {
        WindowRateLimiter(clock, RateRule(limits.perUserPerMinute, 1.minutes))
    }
    private val perUser = ConcurrentHashMap<String, Int>()
    private val global = AtomicInteger()

    /** The largest upload of [route] as the handler sees it - what a 413 names as its limit. */
    fun capOf(route: UploadRoute): Long = when (route) {
        UploadRoute.FILE -> limits.maxFileBytes
        UploadRoute.SNAPSHOT -> limits.maxSnapshotBytes
        UploadRoute.PLUGIN -> limits.maxPluginBytes
    }

    /**
     * Lets an upload of [principal] in, or throws. [contentLength] is -1 when the header is missing; [chunked] says the
     * request has a `Transfer-Encoding` (its length is unknown whatever else it says).
     */
    fun admit(route: UploadRoute, principal: String, contentLength: Long, chunked: Boolean): Slot {
        if (chunked || contentLength < 0) throw ResponseStatusException(HttpStatus.LENGTH_REQUIRED)
        // Content-Length counts the multipart boundaries and part headers as well: the envelope is allowed on top of the cap
        if (contentLength > capOf(route) + limits.envelopeBytes) throw PayloadTooLargeException(capOf(route))
        started.getValue(route).take(principal)
        return acquire(principal)
    }

    private fun acquire(principal: String): Slot {
        if (global.incrementAndGet() > limits.globalConcurrent) {
            global.decrementAndGet()
            throw RateLimitedException(RETRY_AFTER_SECONDS)
        }
        var granted = false
        // compute() is atomic per key: the count is only ever read and written inside it
        perUser.compute(principal) { _, count ->
            val now = count ?: 0
            granted = now < limits.perUserConcurrent
            if (granted) now + 1 else count
        }
        if (!granted) {
            global.decrementAndGet()
            throw RateLimitedException(RETRY_AFTER_SECONDS)
        }
        return Slot {
            perUser.compute(principal) { _, count -> (count ?: 1).minus(1).takeIf { it > 0 } }
            global.decrementAndGet()
        }
    }

    /** Uploads in flight right now (tests and metrics). */
    val inFlight: Int get() = global.get()

    /** One place of an upload in flight; closing it twice frees it once. */
    class Slot(private val release: () -> Unit) : AutoCloseable {
        private val released = AtomicBoolean()

        override fun close() {
            if (released.compareAndSet(false, true)) release()
        }
    }

    private companion object {
        const val RETRY_AFTER_SECONDS = 1L
    }
}
