package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalManagementPort
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.http.HttpStatus
import org.springframework.http.codec.json.JacksonJsonDecoder
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * What needs real ports: the separate management port and the HTTP server span of Netty. A second application
 * context on purpose (the PostgreSQL container is the same singleton) - keep the tests here few; everything else
 * belongs into @IntegrationTest.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=http://localhost:1/realms/never-contacted",
        "OIDC_AUDIENCE=$AUDIENCE",
        "management.server.port=0",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class RealServerIntegrationTest(
    @LocalServerPort private val serverPort: Int,
    @LocalManagementPort private val managementPort: Int,
    jsonMapper: JsonMapper,
) {
    /** A client of its own (real port) - with the application's JsonMapper, which knows kotlin.uuid / kotlin.time. */
    private val app = WebTestClient.bindToServer().baseUrl("http://localhost:$serverPort")
        .codecs { it.defaultCodecs().jacksonJsonDecoder(JacksonJsonDecoder(jsonMapper)) }
        .build()
    private val management = WebTestClient.bindToServer().baseUrl("http://localhost:$managementPort").build()

    @Nested
    inner class ManagementPort {

        @Test
        fun `when probing health on the management port then 200 UP without a token`() {
            val result = management.get().uri("/actuator/health").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "health on the management port")
            assertContains(result.responseBody.orEmpty(), "\"status\":\"UP\"", message = "health body")
        }

        @Test
        fun `when probing health on the application port then it is not reachable`() {
            val result = app.get().uri("/actuator/health").exchange().expectBody<String>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, result.status, "actuator on the public port")
        }
    }

    @Nested
    inner class RequestIds {

        @Test
        fun `when a request is rejected by security then the error body and header carry the trace id as request id`() {
            val result = app.get().uri("/api/boards").exchange().expectBody<ErrorModel>().returnResult()

            val header = result.responseHeaders.getFirst(RequestCorrelation.REQUEST_ID_HEADER)
            assertTrue(Regex("[0-9a-f]{32}").matches(header.orEmpty()), "request id header is a trace id: $header")
            assertEquals(header, result.responseBody?.requestId, "request id in the body")
            assertEquals(header, result.responseBody?.traceId, "trace id of the server span = request id")
        }
    }
}
