package at.dergeorg.drawboard.gifs.infra

import at.dergeorg.drawboard.gifs.domain.search.requires.GifsMetrics
import at.dergeorg.drawboard.gifs.domain.search.requires.RequestOutcome
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/**
 * `drawboard.gifs.requests{outcome}` (`hit`, `miss`, `upstream_error`, `limited_user`, `limited_instance`, `disabled`), exported as
 * `drawboard_gifs_requests_total` (G8). The label is a fixed set: never a search text, a user, a key or a GIF.
 */
internal class MicrometerGifsMetrics(private val registry: ObjectProvider<MeterRegistry>) : GifsMetrics {

    override fun request(outcome: RequestOutcome) {
        registry.ifAvailable?.counter("drawboard.gifs.requests", "outcome", outcome.label)?.increment()
    }
}
