package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.context.RequestCorrelation
import io.micrometer.context.ThreadLocalAccessor
import org.slf4j.MDC

/**
 * Bridges the request id between the Reactor context and the SLF4J MDC. Registered in
 * META-INF/services/io.micrometer.context.ThreadLocalAccessor; with `spring.reactor.context-propagation=auto`,
 * Reactor and Spring's coroutine support restore it on every thread hop - that is how `requestId` ends up in every
 * log line and on every span.
 */
class RequestIdThreadLocalAccessor : ThreadLocalAccessor<String> {

    override fun key(): Any = RequestCorrelation.REQUEST_ID_KEY

    override fun getValue(): String? = MDC.get(RequestCorrelation.REQUEST_ID_KEY)

    override fun setValue(value: String) = MDC.put(RequestCorrelation.REQUEST_ID_KEY, value)

    override fun setValue() = MDC.remove(RequestCorrelation.REQUEST_ID_KEY)
}
