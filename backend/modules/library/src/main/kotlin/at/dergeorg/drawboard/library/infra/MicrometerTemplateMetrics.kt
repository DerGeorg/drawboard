package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.domain.boards.requires.TemplateMetrics
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider

/** `drawboard.templates.list.refused`: listTemplates calls answered 429 (S7.3). No label, so no personal data. */
internal class MicrometerTemplateMetrics(private val registry: ObjectProvider<MeterRegistry>) : TemplateMetrics {

    override fun listRefused() {
        registry.ifAvailable?.counter("drawboard.templates.list.refused")?.increment()
    }
}
