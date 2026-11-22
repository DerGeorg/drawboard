package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.FieldViolation
import at.dergeorg.drawboard.files.domain.files.model.RangeNotSatisfiableException
import at.dergeorg.drawboard.files.domain.files.model.ScanUnavailableException
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.FieldViolationsException
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.RetryAfterException
import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.MessageSourceResolvable
import org.springframework.core.io.buffer.DataBufferLimitException
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.validation.FieldError
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.bind.support.WebExchangeBindException
import org.springframework.web.method.annotation.HandlerMethodValidationException
import org.springframework.web.reactive.result.method.annotation.ResponseEntityExceptionHandler
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono

/**
 * Every exception that reaches a controller - or happens while Spring is looking for one (unknown route, wrong
 * method, unreadable body) - ends here and leaves as `application/problem+json` with the contract's ErrorModel.
 * 401/403 of the security filter chain never get here; [SecurityProblemHandler] renders those the same way.
 *
 * Log levels: expected client errors INFO without stack trace, 401 DEBUG (expired tokens are noise),
 * 403 WARN (a signed-in user tried something forbidden), everything 5xx ERROR with stack trace. Constant messages,
 * the details as fields (see [problemFields]); a framework exception's message is never logged for a client error -
 * it can echo the rejected input.
 */
@RestControllerAdvice
internal class ApiExceptionHandler(
    private val problems: ProblemFactory,
    private val log: AppLogger,
    /**
     * Limit named in the 413 of an upload that a codec cut off: the multipart reader spools a part to disk up to the size
     * of the largest upload of the API, a video (`spring.webflux.multipart.max-disk-usage-per-part` = `files.max-video-bytes`).
     */
    @Value("\${files.max-video-bytes:524288000}") private val uploadLimitBytes: Long,
) : ResponseEntityExceptionHandler() {

    @ExceptionHandler(DomainException::class)
    fun handleDomain(exception: DomainException, exchange: ServerWebExchange): ResponseEntity<ErrorModel> {
        val code = exception.errorCode
        val logged = ERROR_MESSAGE to exception.message
        if (exception is RetryAfterException && code.status >= SERVER_ERROR) {
            // an upstream service is down: the module logged the cause (a fixed word); a stack trace per request would only add noise
            log.warn(REQUEST_REJECTED, exchange.problemFields(code.status, code, logged))
        } else if (code.status >= SERVER_ERROR) {
            log.error(REQUEST_FAILED, exception, exchange.problemFields(code.status, code, logged))
            exchange.recordServerError(exception)
        } else {
            log.info(REQUEST_REJECTED, exchange.problemFields(code.status, code, logged))
        }
        val violations = (exception as? FieldViolationsException)?.invalidFields.orEmpty()
            .map { FieldViolation(field = it.field, code = it.constraint, message = it.message) }
        val detail = exception.message ?: code.defaultMessage
        val model = problems.create(code, exchange, detail = detail, params = exception.params, violations = violations)
        return respond(
            model,
            retryAfter = (exception as? RateLimitedException)?.retryAfterSeconds ?: (exception as? RetryAfterException)?.retryAfterSeconds,
            contentRangeOf = (exception as? RangeNotSatisfiableException)?.size,
        )
    }

    /**
     * A fail-closed deployment could not scan an upload: the scanner is down, too slow or the blob could not be opened. Temporary, so 503
     * with `Retry-After`, logged at WARN without a stack trace (a clamd that is down would fill the log with one per upload; the counter
     * `drawboard.scans{result="unavailable"}` and its alert tell). The contract's ErrorCode has no code of its own for it, and a published
     * code is not invented for this: the code stays INTERNAL_ERROR, only the status is 503. The reason is a short code, kept out of the body.
     */
    @ExceptionHandler(ScanUnavailableException::class)
    fun handleScanUnavailable(exception: ScanUnavailableException, exchange: ServerWebExchange): ResponseEntity<ErrorModel> {
        val code = ErrorCode.INTERNAL_ERROR
        log.warn(
            REQUEST_REJECTED,
            exchange.problemFields(HttpStatus.SERVICE_UNAVAILABLE.value(), code, "files.scan.reason" to exception.reason),
        )
        exchange.recordServerError(exception) // the exception tag and the error status of the span, as for any 5xx
        val model = problems.create(
            code, exchange, status = HttpStatus.SERVICE_UNAVAILABLE.value(),
            detail = "The upload could not be scanned right now - retry shortly.",
        )
        return respond(model, retryAfter = SCAN_RETRY_AFTER_SECONDS)
    }

    /** A codec stopped reading a body at its limit (multipart part above 50 MB): 413, whatever the framework says. */
    @ExceptionHandler(DataBufferLimitException::class)
    fun handleBodyTooLarge(exception: DataBufferLimitException, exchange: ServerWebExchange): ResponseEntity<ErrorModel> =
        tooLarge(exchange).also { log.debug("upload cut off at its limit", ERROR_TYPE to exception.javaClass.simpleName) }

    private fun tooLarge(exchange: ServerWebExchange) = handleDomain(PayloadTooLargeException(uploadLimitBytes), exchange)

    /**
     * Safety net: an AccessDeniedException thrown inside a handler (there is no method security - permissions live in
     * the route table - but Spring Security may still throw one) becomes 403 instead of 500.
     */
    @ExceptionHandler(AccessDeniedException::class)
    fun handleAccessDenied(exception: AccessDeniedException, exchange: ServerWebExchange): ResponseEntity<ErrorModel> {
        val code = ErrorCode.FORBIDDEN
        log.warn(REQUEST_REJECTED, exchange.problemFields(code.status, code, ERROR_TYPE to exception.javaClass.simpleName))
        return respond(problems.create(ErrorCode.FORBIDDEN, exchange))
    }

    /**
     * A concurrent request won between read and write - Spring's translation of the version conflict of `save()`.
     * Use cases usually turn it into a CONFLICT with the current version themselves; this is the safety net.
     */
    @ExceptionHandler(OptimisticLockingFailureException::class)
    fun handleConcurrentChange(
        exception: OptimisticLockingFailureException,
        exchange: ServerWebExchange,
    ): ResponseEntity<ErrorModel> {
        val code = ErrorCode.CONFLICT
        val detail = ERROR_TYPE to exception.javaClass.simpleName
        log.info(REQUEST_REJECTED, exchange.problemFields(code.status, code, detail))
        return respond(problems.create(code, exchange))
    }

    @ExceptionHandler(AuthenticationException::class)
    fun handleAuthentication(exception: AuthenticationException, exchange: ServerWebExchange): ResponseEntity<ErrorModel> {
        val code = ErrorCode.UNAUTHORIZED
        log.debug(REQUEST_REJECTED, exchange.problemFields(code.status, code, ERROR_TYPE to exception.javaClass.simpleName))
        return respond(problems.create(ErrorCode.UNAUTHORIZED, exchange))
    }

    @ExceptionHandler(Exception::class)
    fun handleUnexpected(exception: Exception, exchange: ServerWebExchange): ResponseEntity<ErrorModel> {
        // the stack trace goes to the log, never to the client
        log.error(REQUEST_FAILED, exception, exchange.problemFields(ErrorCode.INTERNAL_ERROR.status, ErrorCode.INTERNAL_ERROR))
        exchange.recordServerError(exception)
        return respond(problems.create(ErrorCode.INTERNAL_ERROR, exchange))
    }

    /** Spring's own exceptions (404 route, 405, 415, unreadable body, bean validation ...) with their status. */
    override fun handleExceptionInternal(
        ex: Exception,
        body: Any?,
        headers: HttpHeaders?,
        status: HttpStatusCode,
        exchange: ServerWebExchange,
    ): Mono<ResponseEntity<Any>> {
        if (generateSequence<Throwable>(ex) { it.cause }.any { it is DataBufferLimitException }) {
            // Spring's multipart reader wraps its limit in a 400
            @Suppress("UNCHECKED_CAST")
            return Mono.just(tooLarge(exchange) as ResponseEntity<Any>)
        }
        val violations = violationsOf(ex)
        val code = if (violations.isNotEmpty()) ErrorCode.VALIDATION_FAILED else problems.codeFor(status.value())
        val detail = ERROR_TYPE to ex.javaClass.simpleName
        if (status.is5xxServerError) {
            log.error(REQUEST_FAILED, ex, exchange.problemFields(status.value(), code, detail))
            exchange.recordServerError(ex)
        } else {
            log.info(REQUEST_REJECTED, exchange.problemFields(status.value(), code, detail))
        }
        val model = problems.create(code, exchange, status = status.value(), violations = violations)
        val response = ResponseEntity.status(status)
            .headers { target -> headers?.let(target::addAll) } // keeps Allow (405) and Accept (415)
            .contentType(MediaType.APPLICATION_PROBLEM_JSON)
            .body<Any>(model)
        return Mono.just(response)
    }

    private fun violationsOf(exception: Exception): List<FieldViolation> = when (exception) {
        is WebExchangeBindException -> exception.bindingResult.fieldErrors.map { it.toViolation(it.field) }
        is HandlerMethodValidationException -> exception.parameterValidationResults.flatMap { result ->
            val parameter = result.methodParameter.parameterName ?: "parameter"
            result.resolvableErrors.map { error -> error.toViolation((error as? FieldError)?.field ?: parameter) }
        }
        else -> emptyList()
    }

    private fun MessageSourceResolvable.toViolation(field: String) = FieldViolation(
        field = field,
        // the most specific code is first ("Size.newTask.title"), the plain constraint name last ("Size")
        code = codes?.lastOrNull() ?: "Invalid",
        message = defaultMessage ?: "is invalid",
    )

    private fun respond(model: ErrorModel, retryAfter: Long? = null, contentRangeOf: Long? = null): ResponseEntity<ErrorModel> {
        val response = ResponseEntity.status(model.status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
        if (model.status == UNAUTHORIZED) response.header(HttpHeaders.WWW_AUTHENTICATE, "Bearer")
        if (retryAfter != null) response.header(HttpHeaders.RETRY_AFTER, retryAfter.toString())
        if (contentRangeOf != null) response.header(HttpHeaders.CONTENT_RANGE, "bytes */$contentRangeOf") // 416 (S4.7)
        return response.body(model)
    }

    private companion object {
        const val SERVER_ERROR = 500
        const val SCAN_RETRY_AFTER_SECONDS = 30L
        const val UNAUTHORIZED = 401
        const val REQUEST_REJECTED = "request rejected"
        const val REQUEST_FAILED = "request failed"
        const val ERROR_MESSAGE = "error.message"
        const val ERROR_TYPE = "error.type"
    }
}
