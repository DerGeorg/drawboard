package at.dergeorg.drawboard.shared.observability

import io.micrometer.observation.Observation
import io.micrometer.observation.ObservationHandler
import io.micrometer.observation.ObservationRegistry
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.aop.aspectj.annotation.AspectJProxyFactory
import org.springframework.transaction.ReactiveTransaction
import org.springframework.transaction.ReactiveTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.interceptor.TransactionInterceptor
import reactor.core.publisher.Mono
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.toJavaDuration
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class WithSpanAspectTest {

    private val finished = CopyOnWriteArrayList<FinishedObservation>()
    private val registry = ObservationRegistry.create().apply {
        observationConfig().observationHandler(RecordingHandler(finished))
    }
    private val target = SampleService()
    private val service: SampleService = proxied(target)

    private fun <T : Any> proxied(bean: T, transactional: Boolean = false): T = AspectJProxyFactory(bean).run {
        addAspect(WithSpanAspect(registry))
        if (transactional) {
            // Inside the span, like in the application (WithSpanAspect.ORDER is before @Transactional).
            addAdvice(TransactionInterceptor(AsyncCommitTransactionManager(), AnnotationTransactionAttributeSource()))
        }
        getProxy()
    }

    @Nested
    inner class PlainFunctions {

        @Test
        fun `when an annotated function is called then one observation named Class dot method is recorded`() {
            service.plain("abc")

            assertEquals(listOf("SampleService.plain"), finished.map { it.contextualName }, "span names of the recorded observations")
            assertEquals(WithSpanAspect.OBSERVATION_NAME, finished.single().name, "observation (and timer) name")
        }

        @Test
        fun `when a parameter carries SpanAttribute then it becomes a high cardinality key value`() {
            service.plain("abc")

            assertEquals("abc", finished.single().highCardinality["sample.value"], "span attribute of the observation")
        }

        @Test
        fun `when the function throws then the observation records the error`() {
            runCatching { service.failing() }

            assertIs<IllegalStateException>(finished.single().error, "error attached to the observation")
        }
    }

    @Nested
    inner class SuspendFunctions {

        @Test
        fun `when a suspend function suspends then the observation covers the whole call`() = runTest {
            val result = service.suspending(delayMillis = 20)

            assertEquals("done", result, "result passes through the aspect")
            assertEquals(listOf("SampleService.suspending"), finished.map { it.contextualName }, "span names of the recorded observations")
            assertTrue(
                finished.single().stoppedAtNanos >= target.bodyFinishedAtNanos,
                "observation must end after the function body finished, not at its first suspension",
            )
        }
    }

    @Nested
    inner class NestedSuspendFunctions {

        private val inner = proxied(InnerService(), transactional = true)
        private val outer = proxied(OuterService(inner))

        /**
         * The trace from phase 1 in which BoardService.createTask (child) outlasted BoardApiService.createTask.
         *
         * WebFlux runs suspend handlers on Dispatchers.Unconfined. The inner function is @Transactional: its
         * Mono completes only after the commit, and the commit completes on a database thread - not as a coroutine
         * resumption. That completion signal resumes the outer coroutine on the same stack, and the outer body
         * runs to its end (and ends its span) before the signal returns to the inner Mono. A span stopped in
         * doFinally (which runs after the signal went downstream) therefore ended after its parent.
         */
        @Test
        fun `when a transactional suspend function completes on another thread then the child span ends within the parent span`() =
            runTest {
                val result = withContext(Dispatchers.Unconfined) { outer.createTask("title") }

                assertEquals("TITLE", result, "result passes through both proxies")
                val parent = finished.single { it.contextualName == "OuterService.createTask" }
                val child = finished.single { it.contextualName == "InnerService.createTask" }
                assertEquals("OuterService.createTask", child.parentContextualName, "parent observation of the inner span")
                assertTrue(child.startedAtNanos >= parent.startedAtNanos, "child span must start after its parent span started")
                assertTrue(child.stoppedAtNanos <= parent.stoppedAtNanos, "child span must end before its parent span ends")
                assertEquals(
                    listOf("InnerService.createTask", "OuterService.createTask"),
                    finished.map { it.contextualName },
                    "order in which the spans end: inner first, then outer",
                )
            }
    }

    /** Commits on Reactor's parallel scheduler, like R2DBC commits on a driver thread. */
    private class AsyncCommitTransactionManager : ReactiveTransactionManager {
        override fun getReactiveTransaction(definition: TransactionDefinition?): Mono<ReactiveTransaction> =
            Mono.just(object : ReactiveTransaction {})

        override fun commit(transaction: ReactiveTransaction): Mono<Void> =
            Mono.delay(COMMIT_MILLIS.milliseconds.toJavaDuration()).then()

        override fun rollback(transaction: ReactiveTransaction): Mono<Void> = Mono.empty()

        private companion object {
            const val COMMIT_MILLIS = 5L
        }
    }

    /** Must be open: the proxy subclasses it (kotlin-spring only opens Spring-annotated classes). */
    open class InnerService {
        @WithSpan
        @Transactional
        open suspend fun createTask(title: String): String = title.uppercase()
    }

    /** Calls [inner] through its proxy, like BoardApiService calls BoardService. */
    open class OuterService(private val inner: InnerService) {
        @WithSpan
        open suspend fun createTask(title: String): String {
            // No suspension after the inner call (like mapping its result): the outer body ends on the stack
            // that completed the inner one.
            return inner.createTask(title)
        }
    }

    /** Must be open: the proxy subclasses it (kotlin-spring only opens Spring-annotated classes). */
    open class SampleService {

        @Volatile
        var bodyFinishedAtNanos: Long = Long.MAX_VALUE

        @WithSpan
        open fun plain(@SpanAttribute("sample.value") value: String): String = value.uppercase()

        @WithSpan
        open fun failing(): String = error("boom")

        @WithSpan
        open suspend fun suspending(delayMillis: Long): String {
            delay(delayMillis)
            bodyFinishedAtNanos = System.nanoTime()
            return "done"
        }
    }

    data class FinishedObservation(
        val name: String?,
        val contextualName: String?,
        val highCardinality: Map<String, String>,
        val error: Throwable?,
        val parentContextualName: String?,
        val startedAtNanos: Long,
        val stoppedAtNanos: Long,
    )

    private class RecordingHandler(private val sink: MutableList<FinishedObservation>) : ObservationHandler<Observation.Context> {
        override fun supportsContext(context: Observation.Context): Boolean = true

        override fun onStart(context: Observation.Context) {
            context.put(STARTED_AT, System.nanoTime())
        }

        override fun onStop(context: Observation.Context) {
            sink += FinishedObservation(
                name = context.name,
                contextualName = context.contextualName,
                highCardinality = context.highCardinalityKeyValues.associate { it.key to it.value },
                error = context.error,
                parentContextualName = context.parentObservation?.contextView?.contextualName,
                startedAtNanos = context.getRequired(STARTED_AT),
                stoppedAtNanos = System.nanoTime(),
            )
        }

        private companion object {
            const val STARTED_AT = "test.startedAtNanos"
        }
    }
}
