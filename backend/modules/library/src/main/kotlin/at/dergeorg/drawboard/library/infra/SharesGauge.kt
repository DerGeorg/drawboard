package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import at.dergeorg.drawboard.shared.logging.AppLogger
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.SmartLifecycle
import java.util.concurrent.atomic.AtomicLong
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes

/**
 * `drawboard.share.links.active{audience}`: how many share links work (neither revoked nor expired), by audience. Like
 * [BoardsGauge], the number is read every five minutes - a scrape must not block on R2DBC.
 */
internal class SharesGauge(
    private val links: ShareLinkRepository,
    private val registry: ObjectProvider<MeterRegistry>,
    private val clock: Clock,
    private val logger: AppLogger,
) : SmartLifecycle {

    private val counts = ShareAudience.entries.associateWith { AtomicLong() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var running = false

    /** Reads the numbers once and registers the gauges on first use. */
    suspend fun refresh() {
        val now = clock.now()
        counts.forEach { (audience, count) -> count.set(links.countUsable(audience, now)) }
        gauges.value
    }

    private val gauges = lazy {
        counts.forEach { (audience, count) ->
            Gauge.builder("drawboard.share.links.active") { count.get() }.tag("audience", audience.name.lowercase())
                .register(registry.getObject())
        }
    }

    override fun start() {
        running = true
        scope.launch {
            while (true) {
                try {
                    refresh()
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                    logger.error("reading the number of share links failed", e)
                }
                delay(REFRESH)
            }
        }
    }

    override fun stop() {
        running = false
        scope.cancel()
    }

    override fun isRunning(): Boolean = running

    private companion object {
        val REFRESH = 5.minutes
    }
}
