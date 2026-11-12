package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.context.Actor
import at.dergeorg.drawboard.shared.context.CurrentUserProvider
import at.dergeorg.drawboard.shared.context.RequestContext
import at.dergeorg.drawboard.shared.context.RequestContextProvider
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import io.micrometer.tracing.Tracer
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.reactor.ReactorContext
import org.springframework.beans.factory.ObjectProvider
import org.springframework.stereotype.Component

/**
 * Adapter of the shared [RequestContextProvider] port. Spring runs a suspend handler with the request's Reactor
 * context in the coroutine context, so the request id and the security context are found at any call depth; the
 * trace id comes from the current span, which context propagation keeps current across thread hops.
 */
@Component
internal class ReactiveRequestContextProvider(
    private val currentUsers: CurrentUserProvider,
    private val tracer: ObjectProvider<Tracer>,
) : RequestContextProvider {

    override suspend fun current(): RequestContext {
        val reactorContext = currentCoroutineContext()[ReactorContext]?.context
        return RequestContext(
            actor = currentUsers.currentUserOrNull()?.let { Actor.user(it.subject) } ?: Actor.ANONYMOUS,
            requestId = reactorContext?.getOrDefault<String>(RequestCorrelation.REQUEST_ID_KEY, null),
            traceId = tracer.ifAvailable?.currentSpan()?.context()?.traceId(),
        )
    }
}
