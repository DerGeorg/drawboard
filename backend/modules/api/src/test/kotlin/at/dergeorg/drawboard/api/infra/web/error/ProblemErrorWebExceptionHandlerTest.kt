package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import at.dergeorg.drawboard.api.infra.web.docs.ContractDocumentController
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.error.DomainException
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import org.springframework.web.server.MethodNotAllowedException
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.server.WebFilter
import reactor.core.publisher.Mono
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import at.dergeorg.drawboard.shared.error.ErrorCode as DomainErrorCode

/**
 * Errors of a (non-security) WebFilter never reach the controller advice. The failing filter below stands for any
 * such filter; it runs after the request id is known, like every filter of the application. The controller of the
 * slice does not matter (the filter fails before routing) - it is one without dependencies.
 */
@WebFluxTest(ContractDocumentController::class)
@Import(WebSliceTestConfiguration::class, ProblemErrorWebExceptionHandler::class, ProblemErrorWebExceptionHandlerTest.FailingFilter::class)
class ProblemErrorWebExceptionHandlerTest(private val client: WebTestClient) {

    private fun failingWith(failure: String) =
        client.get().uri("/api/boards").header(FAILURE_HEADER, failure).exchange().expectBody<String>().returnResult()

    private fun failingWithModel(failure: String) =
        client.get().uri("/api/boards").header(FAILURE_HEADER, failure).exchange().expectBody<ErrorModel>().returnResult()

    @Nested
    inner class UnexpectedException {

        @Test
        fun `when a filter throws an unexpected exception then 500 INTERNAL_ERROR as problem json without internals`() {
            val result = failingWith("unexpected")

            assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, result.status, "status of a failing filter")
            assertEquals(
                MediaType.APPLICATION_PROBLEM_JSON_VALUE,
                result.responseHeaders.getFirst(HttpHeaders.CONTENT_TYPE),
                "content type of the error",
            )
            val body = result.responseBody.orEmpty()
            assertContains(body, "\"code\":\"INTERNAL_ERROR\"", message = "error code in the body")
            listOf("filter-internal-secret", "IllegalStateException", "\"error\":", "\"path\":").forEach { internal ->
                assertFalse(internal in body, "neither the exception message nor Boot's default error attributes may appear: $internal")
            }
        }

        @Test
        fun `when a filter throws then the body carries the request id and the path like every other error`() {
            val error = assertNotNull(failingWithModel("unexpected").responseBody, "error body")

            assertEquals(REQUEST_ID, error.requestId, "request id from the exchange")
            assertEquals("/api/boards", error.instance, "path of the request")
            assertEquals("Internal Server Error", error.title, "reason phrase")
        }
    }

    @Nested
    inner class KnownExceptions {

        @Test
        fun `when a filter throws a ResponseStatusException then its status and the closest platform code are used`() {
            val result = failingWithModel("status")

            assertEquals(HttpStatus.CONTENT_TOO_LARGE, result.status, "status of the exception")
            assertEquals(ErrorCode.MALFORMED_REQUEST, result.responseBody?.code, "client error without own code")
        }

        @Test
        fun `when a filter throws MethodNotAllowed then 405 METHOD_NOT_ALLOWED keeps the Allow header`() {
            val result = failingWithModel("method")

            assertEquals(HttpStatus.METHOD_NOT_ALLOWED, result.status, "status of the exception")
            assertEquals(ErrorCode.METHOD_NOT_ALLOWED, result.responseBody?.code, "error code")
            assertEquals(setOf(HttpMethod.GET), result.responseHeaders.allow, "Allow header of the exception")
        }

        @Test
        fun `when a filter throws a DomainException then its code, params and message are rendered`() {
            val result = failingWithModel("domain")

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status of the code")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "error code")
            assertEquals(mapOf("boardId" to "42"), result.responseBody?.params, "params")
            assertEquals("Board 42 not found.", result.responseBody?.detail, "rendered message")
        }
    }

    /** Fails the request when the test header asks for it; otherwise passes it on untouched. */
    @TestConfiguration(proxyBeanMethods = false)
    class FailingFilter {

        @Bean
        fun failingWebFilter() = WebFilter { exchange, chain ->
            exchange.attributes[RequestCorrelation.REQUEST_ID_KEY] = REQUEST_ID
            when (exchange.request.headers.getFirst(FAILURE_HEADER)) {
                "unexpected" -> Mono.error(IllegalStateException("filter-internal-secret"))
                "status" -> Mono.error(ResponseStatusException(HttpStatus.CONTENT_TOO_LARGE))
                "method" -> Mono.error(MethodNotAllowedException(HttpMethod.POST, listOf(HttpMethod.GET)))
                "domain" -> Mono.error(DomainException(DomainErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to "42")))
                else -> chain.filter(exchange)
            }
        }
    }

    private companion object {
        const val FAILURE_HEADER = "X-Test-Failure"
        const val REQUEST_ID = "req-filter-0001"
    }
}
