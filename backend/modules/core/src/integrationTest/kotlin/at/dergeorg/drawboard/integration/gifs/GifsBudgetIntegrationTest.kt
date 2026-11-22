package at.dergeorg.drawboard.integration.gifs

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.gif
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.page
import at.dergeorg.drawboard.integration.gifs.FakeGiphyServer.Companion.respond
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * The budget of the instance (G7) with the key in a FILE (`DRAWBOARD_GIPHY_API_KEY_FILE`, G1), the rating `pg` from the environment
 * (G6) and a budget of 3 calls per hour. The instance's budget is shared state, so the tests run in a fixed order: GIPHY's own 429
 * first (it uses one call and blocks for one second), then the budget.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_FILES_DIR=build/gifs-budget-integration",
        "DRAWBOARD_GIPHY_RATING=pg",
        "DRAWBOARD_GIPHY_HOURLY_BUDGET=3",
        "DRAWBOARD_GIPHY_API_KEY=VariableKey0123456789", // the file below wins
        "management.otlp.metrics.export.enabled=false",
        "logging.level.org.springframework.web.reactive.function.client=DEBUG",
        "logging.level.org.springframework.http.client.reactive=DEBUG",
        "logging.level.reactor.netty.http.client=DEBUG",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(FakeGiphyConfiguration::class)
@ExtendWith(OutputCaptureExtension::class)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class GifsBudgetIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val giphy: FakeGiphyServer,
    private val meters: MeterRegistry,
) {

    @BeforeEach
    fun reset() = giphy.reset()

    private fun user() = SharingUser(client, port, "Budget ${Uuid.random()}").http()

    private fun term() = "term${Uuid.random().toString().replace("-", "")}"

    private fun count(outcome: String) = meters.find("drawboard.gifs.requests").tag("outcome", outcome).counter()?.count() ?: 0.0

    private fun WebTestClient.search(q: String) = post().uri("/api/gifs/search").bodyValue(GifSearch(q)).exchange()

    @Test
    @Order(1)
    fun `when GIPHY says 429 then 429 GIFS_BUDGET_EXHAUSTED with its Retry-After, and no other call is made while it lasts`(
        output: CapturedOutput,
    ) {
        // GIPHY reflects the key in its error body: it must reach neither the answer nor a log line
        giphy.handler = { respond(it, 429, """{"message":"too many calls, api_key=FileKey0123456789ab"}""", "Retry-After" to "1") }
        val http = user()
        val before = count("limited_instance")
        val secret = "narwhal${Uuid.random().toString().replace("-", "")}"

        val first = http.search(secret).expectBody<ErrorModel>().returnResult()
        val during = http.search(term()).expectBody<ErrorModel>().returnResult()
        val shown = first.responseBody.toString() + output.all
        assertTrue("FileKey0123456789ab" !in shown, "G2: no key in answer or log")
        assertTrue(secret !in output.all && secret !in first.responseBody.toString(), "G8: no search text in answer or log")

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, first.status, "status")
        assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, first.responseBody?.code, "error code")
        assertEquals("1", first.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After of GIPHY")
        assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, during.responseBody?.code, "the block holds for every text")
        assertEquals(1, giphy.requests.size, "GIPHY was asked once")
        assertEquals(2.0, count("limited_instance") - before, "two answers were counted as limited_instance")
    }

    @Test
    @Order(2)
    fun `when the budget is used up then 429 GIFS_BUDGET_EXHAUSTED with Retry-After, a cached answer still works`() {
        Thread.sleep(BLOCK_OVER_MILLIS) // GIPHY's block of one second is over
        giphy.handler = { respond(it, 200, page(gif("cached1"))) }
        val http = user()
        val cached = term()
        val used = http.search(cached).expectBody<GifPage>().returnResult() // call 2 of 3 (call 1 was the 429)
        http.search(term()).expectBody<String>().returnResult() // call 3 of 3

        val refused = http.search(term()).expectBody<ErrorModel>().returnResult()
        val hit = user().search(cached).expectBody<GifPage>().returnResult()

        assertEquals(HttpStatus.OK, used.status, "inside the budget")
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, refused.status, "fourth call to GIPHY in the hour")
        assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, refused.responseBody?.code, "error code")
        assertTrue((refused.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER)?.toLongOrNull() ?: 0) in 1..3601,
            "Retry-After: ${refused.responseHeaders}")
        assertEquals(HttpStatus.OK, hit.status, "a cache hit needs no budget")
        assertEquals(used.responseBody, hit.responseBody, "the cached page")
        assertEquals(2, giphy.requests.size, "the refused search did not reach GIPHY")
        assertEquals(setOf("pg"), giphy.requests.map { it.query["rating"] }.toSet(),
            "G6: the rating of the instance comes from the environment")
        assertEquals(setOf("FileKey0123456789ab"), giphy.requests.map { it.query["api_key"] }.toSet(),
            "G1: the file wins over the variable")
    }

    companion object {
        private const val BLOCK_OVER_MILLIS = 1500L

        private val keyFile: Path = Files.createTempFile("giphy_api_key", "").also {
            Files.writeString(it, "FileKey0123456789ab\n")
            it.toFile().deleteOnExit()
        }

        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GIPHY_API_KEY_FILE") { keyFile.toString() }
        }
    }
}
