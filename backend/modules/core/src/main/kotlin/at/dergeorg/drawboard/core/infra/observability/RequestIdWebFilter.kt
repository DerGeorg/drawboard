package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.context.RequestCorrelation
import io.micrometer.common.KeyValue
import io.micrometer.tracing.handler.TracingObservationHandler.TracingContext
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.server.reactive.observation.ServerRequestObservationContext
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * Gives every request its request id (see [RequestIds]) before anything else runs - also before security, so
 * 401/403 bodies carry it too. The id goes
 *  - into the response header `X-Request-Id`,
 *  - into the exchange attributes (error bodies) together with the trace id,
 *  - into the Reactor context, from where context propagation copies it into the logging MDC on every thread hop
 *    (RequestIdThreadLocalAccessor) and auditing reads it,
 *  - onto the HTTP server span (all child spans get it from RequestIdSpanProcessor).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
internal class RequestIdWebFilter : WebFilter {

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        // The HTTP server observation is started by the HttpWebHandlerAdapter, i.e. before any WebFilter.
        val observation = ServerRequestObservationContext.findCurrent(exchange.attributes).orElse(null)
        val traceId = observation?.get<TracingContext>(TracingContext::class.java)?.span?.context()?.traceId()
        val requestId = RequestIds.resolve(exchange.request.headers.getFirst(RequestCorrelation.REQUEST_ID_HEADER), traceId)

        exchange.response.headers.set(RequestCorrelation.REQUEST_ID_HEADER, requestId)
        exchange.attributes[RequestCorrelation.REQUEST_ID_KEY] = requestId
        traceId?.let { exchange.attributes[RequestCorrelation.TRACE_ID_KEY] = it }
        observation?.addHighCardinalityKeyValue(KeyValue.of(RequestCorrelation.REQUEST_ID_SPAN_ATTRIBUTE, requestId))
        return chain.filter(exchange).contextWrite { it.put(RequestCorrelation.REQUEST_ID_KEY, requestId) }
    }
}
