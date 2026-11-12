package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.sharing.requires.ShareMetrics
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/**
 * `drawboard.share.exchanges{result}` (`signed_in`, `guest`, or the failure reason - a fixed set, so the label has no
 * personal data) and `drawboard.guest.sessions` (guest sessions started or renewed, S7.1/S7.3).
 */
internal class MicrometerShareMetrics(private val registry: ObjectProvider<MeterRegistry>) : ShareMetrics {

    override fun exchange(result: String) {
        registry.ifAvailable?.counter("drawboard.share.exchanges", "result", result)?.increment()
    }

    override fun guestSession() {
        registry.ifAvailable?.counter("drawboard.guest.sessions")?.increment()
    }
}
