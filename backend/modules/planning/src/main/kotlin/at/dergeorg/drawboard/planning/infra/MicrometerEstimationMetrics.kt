package at.dergeorg.drawboard.planning.infra

import at.dergeorg.drawboard.planning.domain.sessions.requires.EstimationMetrics
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/**
 * `drawboard.planning.sessions{event, mode}`, `drawboard.planning.session.inputs{kind}` and
 * `drawboard.planning.session.refused{reason}` (E17, E23). Labels are a fixed set (S7.10), never a board, a user, a value or a reason.
 */
internal class MicrometerEstimationMetrics(private val registry: ObjectProvider<MeterRegistry>) : EstimationMetrics {

    override fun session(event: String, mode: String) {
        registry.ifAvailable?.counter("drawboard.planning.sessions", "event", event, "mode", mode)?.increment()
    }

    override fun input(kind: String) {
        registry.ifAvailable?.counter("drawboard.planning.session.inputs", "kind", kind)?.increment()
    }

    override fun refused(reason: String) {
        registry.ifAvailable?.counter("drawboard.planning.session.refused", "reason", reason)?.increment()
    }
}
