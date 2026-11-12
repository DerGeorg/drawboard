package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
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
 * `drawboard.storage.bytes{kind="files"}`: the bytes the stored files occupy (the collaboration reports `snapshot` and `log` under
 * the same name). Read every five minutes, because a scrape must not block on R2DBC; the gauge shows the last reading.
 */
internal class FilesStorageGauge(
    private val files: FileRepository,
    private val registry: ObjectProvider<MeterRegistry>,
    private val logger: AppLogger,
) : SmartLifecycle {

    private val bytes = AtomicLong()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var running = false

    /** Reads the number once and registers the gauge on first use. */
    suspend fun refresh() {
        bytes.set(files.totalBytes())
        gauge.value
    }

    private val gauge = lazy {
        Gauge.builder("drawboard.storage.bytes") { bytes.get() }.tag("kind", "files").baseUnit("bytes").register(registry.getObject())
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
                    logger.error("reading the storage used by files failed", e)
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
