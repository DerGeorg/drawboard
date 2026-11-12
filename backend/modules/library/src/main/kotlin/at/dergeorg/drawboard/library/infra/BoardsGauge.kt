package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
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
import kotlin.time.Duration.Companion.minutes

/**
 * `drawboard.boards`: how many boards exist. A database query cannot run when a metric is scraped (the scrape thread
 * must not block on R2DBC), so the number is read every five minutes and the gauge shows the last reading.
 */
internal class BoardsGauge(
    private val boards: BoardRepository,
    private val registry: ObjectProvider<MeterRegistry>,
    private val logger: AppLogger,
) : SmartLifecycle {

    private val count = AtomicLong()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var running = false

    /** Reads the number once and registers the gauge on first use. */
    suspend fun refresh() {
        count.set(boards.count())
        gauge.value
    }

    private val gauge = lazy { Gauge.builder("drawboard.boards") { count.get() }.register(registry.getObject()) }

    override fun start() {
        running = true
        scope.launch {
            while (true) {
                try {
                    refresh()
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                    logger.error("reading the number of boards failed", e)
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
