package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.files.common.FilesModule
import at.dergeorg.drawboard.files.domain.files.ConversionQueue
import at.dergeorg.drawboard.files.domain.files.FilesLimits
import at.dergeorg.drawboard.files.domain.FilesService
import at.dergeorg.drawboard.files.domain.files.requires.Converter
import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import at.dergeorg.drawboard.files.domain.files.requires.Transactions
import at.dergeorg.drawboard.files.domain.images.ImageWorker
import at.dergeorg.drawboard.files.domain.urls.FileUrlSigner
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.springframework.context.SmartLifecycle
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import at.dergeorg.drawboard.files.domain.files.requires.FilesMetrics
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

@Configuration(proxyBeanMethods = false)
internal class FilesConfiguration {

    /** Schema `files`, migrations in db/migration/files. */
    @Bean
    fun filesFlywayModule() = FlywayModule(schema = FilesModule.NAME)

    @Bean
    fun filesLimits(properties: FilesProperties) = FilesLimits(
        maxFileBytes = properties.maxFileBytes,
        maxVideoBytes = properties.maxVideoBytes,
        maxBytesPerUser = properties.maxBytesPerUser,
        maxBytesPerBoard = properties.maxBytesPerBoard,
        maxFilesPerBoard = properties.maxFilesPerBoard,
        uploadsPerMinute = properties.uploadsPerMinute,
        uploadBytesPerMinute = properties.uploadBytesPerMinute,
        conversionsPerMinute = properties.conversionsPerMinute,
        conversionTimeout = properties.conversionTimeoutSeconds.seconds,
        conversionEnabled = properties.gotenbergUrlOrNull != null,
        conversionQueue = properties.conversionQueue,
        orphanGrace = properties.orphanGraceSeconds.seconds,
        scanFailClosed = properties.clamavFailClosed,
    )

    /** A warning at start when fail-closed scanning cannot take the largest upload (S4.12). */
    @Bean
    fun scanLimitsCheck(properties: FilesProperties, logger: AppLogger) = ScanLimitsCheck(properties, logger)

    /** The keys come from the configuration; none, or a short one, stops the start (S4.4). */
    @Bean
    fun fileUrlSigner(properties: FilesProperties, clock: Clock) = FileUrlSigner(properties.signingKeys(), clock)

    @Bean(destroyMethod = "close")
    fun imageWorker(properties: FilesProperties) = ImageWorker(properties.decodeThreads, properties.decodeTimeoutSeconds.seconds)

    /** The scope of everything that outlives a request: the conversion worker and the sweep. */
    @Bean(destroyMethod = "")
    fun filesScope(): FilesScope = FilesScope()

    @Bean
    fun conversionQueue(
        files: FileRepository,
        storage: FileStorage,
        converter: Converter,
        transactions: Transactions,
        audit: AuditTrail,
        limits: FilesLimits,
        scope: FilesScope,
        logger: AppLogger,
        metrics: FilesMetrics,
    ) = ConversionQueue(files, storage, converter, transactions, audit, limits, scope, logger, metrics)

    /** The counters `drawboard.uploads{result}` and `drawboard.conversions{result}`. */
    @Bean
    fun filesMetrics(registry: ObjectProvider<MeterRegistry>): FilesMetrics = MicrometerFilesMetrics(registry)

    /** The gauge `drawboard.storage.bytes{kind="files"}`. */
    @Bean
    fun filesStorageGauge(files: FileRepository, registry: ObjectProvider<MeterRegistry>, logger: AppLogger) =
        FilesStorageGauge(files, registry, logger)

    @Bean
    fun filesMaintenance(queue: ConversionQueue, service: FilesService, properties: FilesProperties, scope: FilesScope, logger: AppLogger) =
        FilesMaintenance(queue, service, properties.sweepIntervalSeconds, scope, logger)
}

/** A [CoroutineScope] of the files module; its own type so it is not mistaken for a request's scope. */
internal class FilesScope : CoroutineScope {
    override val coroutineContext = SupervisorJob() + Dispatchers.Default
}

/** Starts the conversion worker, queues what was pending at the last stop, and sweeps for orphaned blobs (S4.13) once a day. */
internal class FilesMaintenance(
    private val queue: ConversionQueue,
    private val service: FilesService,
    private val sweepSeconds: Long,
    private val scope: FilesScope,
    private val logger: AppLogger,
) : SmartLifecycle {

    @Volatile
    private var running = false

    override fun start() {
        running = true
        queue.start()
        scope.launch {
            guarded("resuming the file conversions") { queue.resume() }
            delay(FIRST_SWEEP_AFTER)
            while (true) {
                guarded("sweeping orphaned file blobs") { service.sweepOrphans() }
                delay(sweepSeconds.seconds)
            }
        }
    }

    private suspend fun guarded(what: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            logger.error("$what failed", e)
        }
    }

    override fun stop() {
        running = false
        queue.stop()
        scope.cancel()
    }

    override fun isRunning(): Boolean = running

    private companion object {
        val FIRST_SWEEP_AFTER = 10.minutes
    }
}
