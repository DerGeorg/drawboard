package at.dergeorg.drawboard.collab.infra

import at.dergeorg.drawboard.collab.common.CollabModule
import at.dergeorg.drawboard.collab.domain.CollabService
import at.dergeorg.drawboard.collab.domain.rooms.CollabMetrics
import at.dergeorg.drawboard.collab.domain.rooms.RoomRegistry
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardActivity
import at.dergeorg.drawboard.collab.domain.storage.requires.SnapshotStore
import at.dergeorg.drawboard.collab.domain.storage.requires.UpdateLog
import at.dergeorg.drawboard.collab.domain.tickets.TicketRegistry
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.binder.MeterBinder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.SmartLifecycle
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds

@Configuration(proxyBeanMethods = false)
internal class CollabConfiguration {

    /** Schema `collab`, migrations in db/migration/collab. */
    @Bean
    fun collabFlywayModule() = FlywayModule(schema = CollabModule.NAME)

    @Bean
    fun collabLimits(properties: CollabProperties): CollabLimits = properties.toLimits()

    /** The scope of everything that outlives a request: joins, closing clean-up, the maintenance loop. */
    @Bean(destroyMethod = "")
    fun collabScope(): CollabScope = CollabScope()

    @Bean
    fun ticketRegistry(limits: CollabLimits, clock: Clock) = TicketRegistry(limits, clock)

    @Bean
    fun roomRegistry(
        log: UpdateLog,
        snapshots: SnapshotStore,
        access: BoardAccess,
        activity: BoardActivity,
        limits: CollabLimits,
        clock: Clock,
        logger: AppLogger,
        scope: CollabScope,
        metrics: CollabMetrics,
    ) = RoomRegistry(log, snapshots, access, activity, limits, clock, logger, scope, metrics)

    @Bean
    fun collabMetrics(registry: ObjectProvider<MeterRegistry>): CollabMetrics = MicrometerCollabMetrics(registry)

    /**
     * `drawboard.collab.sessions` (open WebSockets) and `drawboard.collab.rooms` (boards with at least one session).
     * The rooms are looked up when a gauge is READ: Boot binds MeterBinder beans while it creates the registry, and a
     * binder that needs the rooms (which need the metrics, which need the registry) would be a circular dependency.
     */
    @Bean
    fun collabGauges(rooms: ObjectProvider<RoomRegistry>) = MeterBinder { registry ->
        Gauge.builder("drawboard.collab.sessions") { rooms.ifAvailable?.sessionCount ?: 0 }.register(registry)
        Gauge.builder("drawboard.collab.rooms") { rooms.ifAvailable?.roomCount ?: 0 }.register(registry)
    }

    /**
     * Runs [CollabService.sweep] every few seconds and refreshes the storage gauges every five minutes; closes the
     * sessions with 1001 when the application stops.
     */
    @Bean
    fun collabMaintenance(service: CollabService, properties: CollabProperties, scope: CollabScope, logger: AppLogger) =
        CollabMaintenance(service, properties.sweepSeconds, properties.storageRefreshSeconds, scope, logger)
}

/** A [CoroutineScope] of the collab module; its own type so it is not mistaken for a request's scope. */
internal class CollabScope : CoroutineScope {
    override val coroutineContext = SupervisorJob() + Dispatchers.Default
}

internal class CollabMaintenance(
    private val service: CollabService,
    private val sweepSeconds: Long,
    private val storageRefreshSeconds: Long,
    private val scope: CollabScope,
    private val logger: AppLogger,
) : SmartLifecycle {

    @Volatile
    private var running = false

    override fun start() {
        running = true
        scope.launch {
            var untilStorageRefresh = 0L
            while (true) {
                try {
                    service.sweep()
                    if (untilStorageRefresh <= 0) {
                        service.refreshStorageMetrics()
                        untilStorageRefresh = storageRefreshSeconds
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                    logger.error("collab maintenance failed", e)
                }
                delay(sweepSeconds.seconds)
                untilStorageRefresh -= sweepSeconds
            }
        }
    }

    override fun stop() {
        running = false
        runBlocking { service.shutdown() }
        scope.cancel()
    }

    override fun isRunning(): Boolean = running
}
