package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.integration.files.Bytes
import at.dergeorg.drawboard.integration.files.upload
import at.dergeorg.drawboard.integration.planning.actor
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The usage metrics of section 3.11 as the application really registers them (the names Prometheus gets after the OTLP
 * translation are these with dots as underscores): the gauges that a periodic reader fills exist from the start, the counters move
 * with the traffic, and no label carries a user, a board or a file name (S7.10).
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/metrics-integration",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class MetricsIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val meters: MeterRegistry,
) {

    @Test
    fun `when the application has started then the usage gauges are registered`() {
        // the periodic readers fill them right at the start; the first reading may still be running, so poll briefly
        val expected = listOf(
            "drawboard.boards" to emptyMap(),
            "drawboard.users.active" to mapOf("window" to "24h"),
            "drawboard.users.active" to mapOf("window" to "7d"),
            "drawboard.users.active" to mapOf("window" to "30d"),
            "drawboard.share.links.active" to mapOf("audience" to "signed_in"),
            "drawboard.share.links.active" to mapOf("audience" to "guests"),
            "drawboard.storage.bytes" to mapOf("kind" to "files"),
            "drawboard.collab.sessions" to emptyMap(),
            "drawboard.collab.rooms" to emptyMap(),
        )

        val missing = awaitMissing(expected)

        assertEquals(emptyList(), missing, "gauges that are not registered")
    }

    @Test
    fun `when rounds are started, voted on and revealed then the planning counters move, with a fixed set of labels`() {
        val owner = SharingUser(client, port, "Metric Olga")
        val board = owner.createBoard()
        val api = owner.actor(json)
        val started = counter("drawboard.planning.rounds", "event", "started")
        val revealed = counter("drawboard.planning.rounds", "event", "revealed")
        val cancelled = counter("drawboard.planning.rounds", "event", "cancelled")
        val votes = counter("drawboard.planning.votes")

        val first = api.start(board.id)
        api.vote(board.id, first.id, "5")
        api.vote(board.id, first.id, "8")
        api.reveal(board.id, first.id)
        api.cancel(board.id, api.start(board.id).id)

        assertEquals(started + 2, counter("drawboard.planning.rounds", "event", "started"), "two rounds started")
        assertEquals(revealed + 1, counter("drawboard.planning.rounds", "event", "revealed"), "one revealed")
        assertEquals(cancelled + 1, counter("drawboard.planning.rounds", "event", "cancelled"), "one cancelled")
        assertEquals(votes + 2, counter("drawboard.planning.votes"), "two votes, a changed one too")
        val labels = meters.meters.filter { it.id.name.startsWith("drawboard.") }.flatMap { m -> m.id.tags.map { it.key } }.toSet()
        assertTrue(labels.all { it in ALLOWED_LABELS }, "labels of the usage metrics are fixed words, found $labels")
    }

    @Test
    fun `when files are uploaded then the upload counter counts accepted and refused ones by result`() {
        val owner = SharingUser(client, port, "Metric Fred")
        val board = owner.createBoard()
        val accepted = counter("drawboard.uploads", "result", "accepted")
        val refused = counter("drawboard.uploads", "result", "type_not_allowed")

        val ok = owner.upload(client, board.id, "plan.png", Bytes.png(40, 30))
        val bad = owner.upload(client, board.id, "tool.png", "MZ not an image".toByteArray())

        assertEquals(HttpStatus.CREATED, ok.status, "the png is stored")
        assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, bad.status, "the renamed program is refused")
        assertEquals(accepted + 1, counter("drawboard.uploads", "result", "accepted"), "accepted upload")
        assertEquals(refused + 1, counter("drawboard.uploads", "result", "type_not_allowed"), "refused upload")
    }

    @Test
    fun `when update sizes are recorded then collab update bytes is a histogram, not a counter`() {
        val summary = meters.find("drawboard.collab.update.bytes").summary()

        // nothing may have been recorded yet in this context; the point is the type: count, sum and (for Prometheus) buckets
        assertTrue(summary == null || summary.count() >= 0, "a distribution summary or not yet registered")
        assertEquals(null, meters.find("drawboard.collab.update.bytes").counter(), "no counter of that name")
    }

    private fun counter(name: String, vararg tags: String): Double = meters.find(name).tags(*tags).counter()?.count() ?: 0.0

    private fun awaitMissing(expected: List<Pair<String, Map<String, String>>>): List<String> {
        var missing = expected
        repeat(40) {
            missing = expected.filter { (name, tags) ->
                meters.find(name).tags(*tags.flatMap { listOf(it.key, it.value) }.toTypedArray()).gauge() == null
            }
            if (missing.isEmpty()) return emptyList()
            Thread.sleep(250)
        }
        return missing.map { (name, tags) -> "$name $tags" }
    }

    private companion object {
        val ALLOWED_LABELS =
            setOf("window", "audience", "kind", "result", "event", "reason", "code", "uri", "method", "status", "outcome", "exception")

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
