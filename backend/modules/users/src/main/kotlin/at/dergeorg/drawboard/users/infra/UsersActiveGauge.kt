package at.dergeorg.drawboard.users.infra

import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.users.domain.users.requires.UserProfileRepository
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
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes

/**
 * `drawboard.users.active{window}`: how many users signed in within the last 24 hours (`24h`), 7 days (`7d`) and 30 days (`30d`)
 * - the last login is refreshed by `getCurrentUser`, which the frontend calls on every start. Read every five minutes, because a
 * scrape must not block on R2DBC. A count, never a name (S7.10).
 */
internal class UsersActiveGauge(
    private val profiles: UserProfileRepository,
    private val registry: ObjectProvider<MeterRegistry>,
    private val clock: Clock,
    private val logger: AppLogger,
) : SmartLifecycle {

    private val counts = WINDOWS.keys.associateWith { AtomicLong() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var running = false

    /** Reads the numbers once and registers the gauges on first use. */
    suspend fun refresh() {
        val now = clock.now()
        WINDOWS.forEach { (label, window) -> counts.getValue(label).set(profiles.countLoggedInSince(now - window)) }
        gauges.value
    }

    private val gauges = lazy {
        counts.forEach { (label, count) ->
            Gauge.builder("drawboard.users.active") { count.get() }.tag("window", label).register(registry.getObject())
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
                    logger.error("reading the number of active users failed", e)
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
        val WINDOWS: Map<String, Duration> = linkedMapOf("24h" to 24.hours, "7d" to 7.days, "30d" to 30.days)
    }
}
