package at.dergeorg.drawboard.integration

import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.testing.TestUsers.BOB
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.ExtendWith
import org.springframework.boot.test.system.CapturedOutput
import org.springframework.boot.test.system.OutputCaptureExtension
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import kotlin.uuid.Uuid
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * What the injected AppLogger really writes: one ECS JSON line on stdout, the fields of the call as JSON fields of
 * their own (dotted keys become nested objects), the request id from the MDC.
 */
@IntegrationTest
@ExtendWith(OutputCaptureExtension::class)
class LoggingIntegrationTest(private val client: WebTestClient, private val jsonMapper: JsonMapper) {

    @Nested
    inner class EcsOutput {

        @Test
        fun `when a request is rejected then the log line carries the fields of the call and the request id`(output: CapturedOutput) {
            val requestId = "logging-it-${Uuid.random()}"

            val result = client.signedInAs(BOB).get().uri("/api/boards/{id}", Uuid.random())
                .header(RequestCorrelation.REQUEST_ID_HEADER, requestId).exchange().expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status of the rejected request")
            val line = assertNotNull(
                output.out.lines().filter { it.startsWith("{") }.map(jsonMapper::readTree)
                    .firstOrNull { it.path(RequestCorrelation.REQUEST_ID_KEY).asString() == requestId && it.path("error").isObject },
                "an ECS line of the request with an error field",
            )
            assertEquals("request rejected", line.path("message").asString(), "constant message")
            assertEquals("INFO", line.at("/log/level").asString(), "level of a client error")
            assertEquals("LIBRARY_BOARD_NOT_FOUND", line.at("/error/code").asString(), "error.code as nested JSON field")
            assertEquals("GET", line.at("/http/request/method").asString(), "http.request.method as nested JSON field")
            assertEquals(404, line.at("/http/response/status_code").asInt(), "http.response.status_code keeps its number type")
            assertEquals(
                "at.dergeorg.drawboard.api.infra.web.error.ApiExceptionHandler",
                line.at("/log/logger").asString(),
                "the logger is named after the class it was injected into",
            )
            assertEquals(true, line.path("traceId").isString, "trace id from the MDC: ${line.path("traceId")}")
        }
    }
}
