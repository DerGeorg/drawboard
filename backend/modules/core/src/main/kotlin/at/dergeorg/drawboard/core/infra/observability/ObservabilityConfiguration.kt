package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.observability.TracedPaths
import at.dergeorg.drawboard.shared.observability.WithSpanAspect
import io.micrometer.common.KeyValue
import io.micrometer.common.KeyValues
import io.micrometer.observation.ObservationPredicate
import io.micrometer.observation.ObservationRegistry
import io.opentelemetry.context.Context
import io.opentelemetry.sdk.trace.ReadWriteSpan
import io.opentelemetry.sdk.trace.ReadableSpan
import io.opentelemetry.sdk.trace.SpanProcessor
import org.slf4j.MDC
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.server.reactive.observation.DefaultServerRequestObservationConvention
import org.springframework.http.server.reactive.observation.ServerRequestObservationContext
import org.springframework.http.server.reactive.observation.ServerRequestObservationConvention

/**
 * Wiring of the observability parts. What is exported where is configuration (application.yaml): traces and
 * metrics via OTLP to OTEL_EXPORTER_OTLP_ENDPOINT, logs as ECS JSON on stdout.
 */
@Configuration(proxyBeanMethods = false)
internal class ObservabilityConfiguration {

    /** Spans (and `app.method` timers) for every function annotated with @WithSpan. */
    @Bean
    fun withSpanAspect(registry: ObservationRegistry) = WithSpanAspect(registry)

    /**
     * No traces and no HTTP metrics for health probes. `name` MUST be nullable: R2DBC query observations call
     * predicates with name == null, a non-null Kotlin parameter throws, and r2dbc-proxy silently drops all DB spans.
     */
    @Bean
    fun skipActuatorObservations() = ObservationPredicate { _: String?, context ->
        !(context is ServerRequestObservationContext && context.carrier?.path?.value().orEmpty().startsWith("/actuator"))
    }

    /**
     * The HTTP server observation as Boot builds it, but with the card of a Magic placement or a Rotation estimate masked in
     * `http.url` ([TracedPaths], Fable B1): the trace of a guest's request must not tie a card to a seat. Replaces Boot's default
     * convention (it steps back for any bean of this type); the name stays `http.server.requests`.
     */
    @Bean
    fun serverRequestObservationConvention(): ServerRequestObservationConvention = MaskedServerRequestObservationConvention()

    private class MaskedServerRequestObservationConvention : DefaultServerRequestObservationConvention() {
        override fun getHighCardinalityKeyValues(context: ServerRequestObservationContext): KeyValues =
            KeyValues.of(super.getHighCardinalityKeyValues(context).map { KeyValue.of(it.key, TracedPaths.mask(it.value)) })
    }

    /** `request.id` on EVERY span (WithSpan, R2DBC ...): the MDC holds it on whichever thread the span starts. */
    @Bean
    fun requestIdSpanProcessor(): SpanProcessor = RequestIdSpanProcessor()

    private class RequestIdSpanProcessor : SpanProcessor {
        override fun onStart(parentContext: Context, span: ReadWriteSpan) {
            MDC.get(RequestCorrelation.REQUEST_ID_KEY)?.let { span.setAttribute(RequestCorrelation.REQUEST_ID_SPAN_ATTRIBUTE, it) }
        }

        override fun isStartRequired() = true

        override fun onEnd(span: ReadableSpan) = Unit

        override fun isEndRequired() = false
    }
}
