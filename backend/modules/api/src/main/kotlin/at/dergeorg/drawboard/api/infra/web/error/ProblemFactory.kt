package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.FieldViolation
import at.dergeorg.drawboard.shared.context.RequestCorrelation
import at.dergeorg.drawboard.shared.error.ErrorCode
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import kotlin.time.Clock
import at.dergeorg.drawboard.contract.model.ErrorCode as ContractErrorCode

/**
 * The one place that builds error bodies: the generated [ErrorModel] of the contract, shaped as RFC 9457 problem
 * details. Used by the controller advice and by the 401/403 handlers of the security filter chain.
 *
 * `detail` is always our own English text - never the message of a framework exception, which can echo internals.
 * Stack traces are only ever logged.
 */
@Component
internal class ProblemFactory(private val clock: Clock) {

    fun create(
        code: ErrorCode,
        exchange: ServerWebExchange,
        status: Int = code.status,
        detail: String = code.defaultMessage,
        params: Map<String, String> = emptyMap(),
        violations: List<FieldViolation> = emptyList(),
    ) = ErrorModel(
        code = ContractErrorCode.forValue(code.name),
        status = status,
        title = HttpStatus.resolve(status)?.reasonPhrase ?: "Error",
        timestamp = clock.now(),
        detail = detail,
        instance = exchange.request.path.value(),
        params = params.ifEmpty { null },
        violations = violations.ifEmpty { null },
        requestId = exchange.getAttribute(RequestCorrelation.REQUEST_ID_KEY),
        traceId = exchange.getAttribute(RequestCorrelation.TRACE_ID_KEY),
    )

    /** Framework exceptions only carry a status: map it to the closest platform code. */
    fun codeFor(status: Int): ErrorCode = when (status) {
        HttpStatus.UNAUTHORIZED.value() -> ErrorCode.UNAUTHORIZED
        HttpStatus.FORBIDDEN.value() -> ErrorCode.FORBIDDEN
        HttpStatus.NOT_FOUND.value() -> ErrorCode.NOT_FOUND
        HttpStatus.METHOD_NOT_ALLOWED.value() -> ErrorCode.METHOD_NOT_ALLOWED
        HttpStatus.NOT_ACCEPTABLE.value() -> ErrorCode.NOT_ACCEPTABLE
        HttpStatus.CONFLICT.value() -> ErrorCode.CONFLICT
        HttpStatus.UNSUPPORTED_MEDIA_TYPE.value() -> ErrorCode.UNSUPPORTED_MEDIA_TYPE
        in CLIENT_ERRORS -> ErrorCode.MALFORMED_REQUEST
        else -> ErrorCode.INTERNAL_ERROR
    }

    private companion object {
        val CLIENT_ERRORS = 400..499
    }
}
