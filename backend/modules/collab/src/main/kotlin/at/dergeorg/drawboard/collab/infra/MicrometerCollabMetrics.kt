package at.dergeorg.drawboard.collab.infra

import at.dergeorg.drawboard.collab.domain.rooms.CollabMetrics
import at.dergeorg.drawboard.collab.domain.rooms.CompactionResult
import at.dergeorg.drawboard.collab.domain.rooms.DropReason
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The collaboration metrics for Prometheus/Grafana (pushed by OTLP like every other metric): `drawboard.collab.updates`,
 * `.update.bytes` (a histogram of the sizes: count, sum and buckets), `.dropped{reason}`, `.closes{code}`, `.compactions{result}` and `drawboard.storage.bytes{kind}`.
 * (`drawboard.collab.sessions` and `.rooms` are gauges on the registry, see [CollabConfiguration].) Labels carry the
 * reason, the close code, the result and the kind - never a user, a board or a ticket (S7.10).
 */
internal class MicrometerCollabMetrics(private val registryProvider: ObjectProvider<MeterRegistry>) : CollabMetrics {

    /** Looked up on use: the rooms that report here are created while Boot is still building the registry. */
    private val registry: MeterRegistry get() = registryProvider.getObject()


    private val storage = ConcurrentHashMap<String, AtomicLong>()

    override fun updateAccepted(bytes: Int) {
        registry.counter("drawboard.collab.updates").increment()
        DistributionSummary.builder("drawboard.collab.update.bytes").baseUnit("bytes").publishPercentileHistogram().register(registry)
            .record(bytes.toDouble())
    }

    override fun dropped(reason: DropReason) {
        registry.counter("drawboard.collab.dropped", "reason", reason.tag).increment()
    }

    override fun closed(code: String) {
        registry.counter("drawboard.collab.closes", "code", code).increment()
    }

    override fun compaction(result: CompactionResult) {
        registry.counter("drawboard.collab.compactions", "result", result.tag).increment()
    }

    override fun storageBytes(kind: String, bytes: Long) {
        storage.computeIfAbsent(kind) { name ->
            AtomicLong().also { holder ->
                Gauge.builder("drawboard.storage.bytes") { holder.get() }
                    .tag("kind", name).baseUnit("bytes").register(registry)
            }
        }.set(bytes)
    }
}
