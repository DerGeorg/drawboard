package at.dergeorg.drawboard.shared.observability

import io.micrometer.common.KeyValue
import io.micrometer.observation.Observation
import io.micrometer.observation.ObservationRegistry
import io.micrometer.observation.contextpropagation.ObservationThreadLocalAccessor
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.aspectj.lang.ProceedingJoinPoint
import org.aspectj.lang.annotation.Around
import org.aspectj.lang.annotation.Aspect
import org.aspectj.lang.reflect.MethodSignature
import org.springframework.core.DefaultParameterNameDiscoverer
import org.springframework.core.KotlinDetector
import org.springframework.core.Ordered
import org.springframework.util.ClassUtils
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import reactor.util.context.ContextView
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Honours OpenTelemetry's `@WithSpan` / `@SpanAttribute` on Spring beans: every annotated call becomes a
 * Micrometer [Observation], which Boot's OpenTelemetry bridge turns into a span (named `Class.method`) and a
 * timer (`app.method`, tags `code.namespace` / `code.function`).
 *
 * Why our own aspect: neither Boot nor Micrometer understands `@WithSpan`, and the OpenTelemetry Spring starter
 * and Java agent both produce broken spans for Kotlin `suspend` functions (ending at the first suspension, or
 * duplicated). Here, Spring AOP hands a suspend function to us as a cold `Mono`; the observation starts on
 * subscription and is written into the Reactor context. With `spring.reactor.context-propagation=auto`,
 * everything below it - nested `@WithSpan` calls, R2DBC queries, the logging MDC - sees it as the parent, also
 * after coroutine thread hops.
 *
 * Supported: plain functions, `suspend` functions, `Mono`/`Flux` return types. Not supported: `WithSpan.kind`
 * (always INTERNAL), `inheritContext = false`. `@SpanAttribute` uses `toString()` - annotate scalar parameters
 * only, never commands or anything with personal data.
 *
 * Order ([ORDER]): right after Spring's ExposeInvocationInterceptor (which AspectJ advice needs), before
 * @Transactional, so the span covers the transaction. Should a project switch on reactive method security after all
 * (this one does not - permissions live in the route table), the order matters even more: method security proceeds
 * lazily, after the call has returned, and an AspectJ advice running after it finds no current invocation
 * ("JoinPointMatch was NOT bound in invocation").
 *
 * Registered as a bean by core (ObservabilityConfiguration).
 */
@Aspect
class WithSpanAspect(private val registry: ObservationRegistry) : Ordered {

    override fun getOrder(): Int = ORDER

    private val parameterNames = DefaultParameterNameDiscoverer()

    @Around("@annotation(withSpan)")
    fun around(joinPoint: ProceedingJoinPoint, withSpan: WithSpan): Any? {
        val method = (joinPoint.signature as MethodSignature).method
        val targetClass = joinPoint.target?.let { ClassUtils.getUserClass(it) } ?: method.declaringClass
        val span = SpanDefinition(withSpan, targetClass, method, joinPoint.args)

        if (!isReactive(method)) {
            return newObservation(span, parent = null).observeChecked<Any?, Throwable> { joinPoint.proceed() }
        }
        // A suspend function arrives here as a cold Mono/Flux (Spring's CoroutinesUtils): observe the subscription.
        return when (val result = joinPoint.proceed()) {
            is Mono<*> -> Mono.deferContextual { context ->
                val observation = newObservation(span, parentFrom(context)).start()
                val stop = stopOnce(observation)
                result.doOnError(observation::error)
                    .doOnTerminate(stop)
                    .doOnCancel(stop)
                    .contextWrite { it.put(ObservationThreadLocalAccessor.KEY, observation) }
            }
            is Flux<*> -> Flux.deferContextual { context ->
                val observation = newObservation(span, parentFrom(context)).start()
                val stop = stopOnce(observation)
                result.doOnError(observation::error)
                    .doOnTerminate(stop)
                    .doOnCancel(stop)
                    .contextWrite { it.put(ObservationThreadLocalAccessor.KEY, observation) }
            }
            else -> result
        }
    }

    /**
     * Stops [observation] exactly once, BEFORE the terminal signal travels downstream (doOnTerminate), not after it
     * (doFinally). The caller is usually a coroutine on Dispatchers.Unconfined: the signal resumes it on the same
     * stack, and it may run to its own end - and stop its own span - before the signal returns here. With doFinally,
     * a @Transactional child (its Mono completes after the commit, on a driver thread) ended after its parent.
     * Cancellation (client gone, timeout) has no terminal signal, hence doOnCancel.
     */
    private fun stopOnce(observation: Observation): Runnable {
        val stopped = AtomicBoolean(false)
        return Runnable { if (stopped.compareAndSet(false, true)) observation.stop() }
    }

    private fun isReactive(method: Method): Boolean =
        KotlinDetector.isSuspendingFunction(method) ||
            Mono::class.java.isAssignableFrom(method.returnType) ||
            Flux::class.java.isAssignableFrom(method.returnType)

    private fun parentFrom(context: ContextView): Observation? =
        context.getOrDefault<Observation>(ObservationThreadLocalAccessor.KEY, null) ?: registry.currentObservation

    private fun newObservation(span: SpanDefinition, parent: Observation?): Observation {
        val observation = Observation.createNotStarted(OBSERVATION_NAME, registry)
            .contextualName(span.name)
            .lowCardinalityKeyValue(KeyValue.of("code.namespace", span.targetClass.name))
            .lowCardinalityKeyValue(KeyValue.of("code.function", span.method.name))
        parent?.let(observation::parentObservation)
        spanAttributes(span).forEach { (key, value) -> observation.highCardinalityKeyValue(key, value) }
        return observation
    }

    private fun spanAttributes(span: SpanDefinition): List<Pair<String, String>> {
        val names by lazy { parameterNames.getParameterNames(span.method) }
        return span.method.parameterAnnotations.withIndex().mapNotNull { (index, annotations) ->
            val attribute = annotations.filterIsInstance<SpanAttribute>().firstOrNull() ?: return@mapNotNull null
            val key = attribute.value.ifBlank { names?.getOrNull(index) ?: "arg$index" }
            span.args.getOrNull(index)?.let { key to it.toString() }
        }
    }

    private class SpanDefinition(withSpan: WithSpan, val targetClass: Class<*>, val method: Method, val args: Array<Any?>) {
        val name: String = withSpan.value.ifBlank { "${targetClass.simpleName}.${method.name}" }
    }

    companion object {
        /** Observation and timer name. The span name is the contextual name `Class.method`. */
        const val OBSERVATION_NAME = "app.method"

        const val ORDER = Ordered.HIGHEST_PRECEDENCE + 10
    }
}
