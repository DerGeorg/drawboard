package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.shared.context.CurrentUser
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SpanProcessor
import io.opentelemetry.sdk.trace.data.SpanData
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.mockJwt
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.web.reactive.server.WebTestClient

/**
 * The whole application against PostgreSQL 18 (Testcontainers), HTTP through WebTestClient.
 *
 * Every integration test class uses exactly this annotation and nothing else that changes the context (no
 * @MockkBean, no extra properties): then Spring's context cache starts the application once for all of them. The
 * PostgreSQL container is a singleton of the test JVM anyway ([PostgresTestcontainerInitializer]).
 *
 * No identity provider is needed: [signedInAs] puts a token in place (mockJwt) that carries the claims the
 * application's claim configuration reads (`iss`, `sub`, `preferred_username`, `name`, `email`, `groups`). The issuer
 * below is never contacted. Alice's group is the admin group of the test configuration.
 */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
@SpringBootTest(
    properties = [
        "OIDC_ISSUER_URI=http://localhost:1/realms/never-contacted",
        "OIDC_AUDIENCE=$AUDIENCE",
        "DRAWBOARD_ADMIN_GROUP=$ADMIN_GROUP",
        "APP_ENVIRONMENT=test",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S") // the 5 s default is too short on a busy CI runner (first requests warm up)
@AutoConfigureTracing // Boot disables tracing in tests otherwise - but trace ids end up in audit rows and error bodies
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(CapturedSpans::class)
annotation class IntegrationTest

const val ADMIN_GROUP = "drawboard-admins"
const val AUDIENCE = "drawboard-api"

/** Every finished span of the application, in memory, for assertions on the trace structure. */
@TestConfiguration(proxyBeanMethods = false)
class CapturedSpans {
    private val exporter = InMemorySpanExporter.create()

    val finished: List<SpanData> get() = exporter.finishedSpanItems

    fun clear() = exporter.reset()

    /** Synchronous, so a span is visible as soon as it ends (Boot's own processor batches). */
    @Bean
    fun capturedSpansProcessor(): SpanProcessor = SimpleSpanProcessor.create(exporter)
}

/** Requests of this client carry an access token of [user], shaped like one from the dev realm (groups claim `groups`). */
fun WebTestClient.signedInAs(user: CurrentUser): WebTestClient = mutateWith(
    mockJwt().jwt { token ->
        token.issuer(user.issuer)
            .subject(user.subject)
            .claim("preferred_username", user.username)
            .claim("groups", user.groups.toList())
        user.displayName?.let { token.claim("name", it) }
        user.email?.let { token.claim("email", it).claim("email_verified", true) }
    },
)
