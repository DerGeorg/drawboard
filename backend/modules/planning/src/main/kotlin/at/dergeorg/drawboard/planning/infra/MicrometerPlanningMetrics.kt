package at.dergeorg.drawboard.planning.infra

import at.dergeorg.drawboard.planning.domain.rounds.requires.PlanningMetrics
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/**
 * `drawboard.planning.rounds{event}` (`started`, `revealed`, `cancelled`), `drawboard.planning.votes` and
 * `drawboard.planning.refused{reason}` (`rate_limit`, `round_full`: S7.3 and the caps of the M4 review). Labels are a fixed set,
 * never a board, a user or a value.
 */
internal class MicrometerPlanningMetrics(private val registry: ObjectProvider<MeterRegistry>) : PlanningMetrics {

    override fun round(event: String) {
        registry.ifAvailable?.counter("drawboard.planning.rounds", "event", event)?.increment()
    }

    override fun vote() {
        registry.ifAvailable?.counter("drawboard.planning.votes")?.increment()
    }

    override fun refused(reason: String) {
        registry.ifAvailable?.counter("drawboard.planning.refused", "reason", reason)?.increment()
    }
}
