package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.boot.webflux.error.ErrorWebExceptionHandler
import org.springframework.core.annotation.Order
import org.springframework.http.HttpHeaders
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.stereotype.Component
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import tools.jackson.databind.json.JsonMapper

/**
 * The last line for errors the controller advice never sees: an exception thrown by a WebFilter (any filter but
 * Spring Security's own 401/403, which [SecurityProblemHandler] renders) or by the framework outside a handler.
 * Without it Boot's DefaultErrorWebExceptionHandler would answer with its own JSON (`timestamp`, `path`, `error`)
 * instead of the contract's ErrorModel.
 *
 * Order -2: before Boot's DefaultErrorWebExceptionHandler (-1; Boot does not even create it while this bean exists)
 * and before Spring's WebFluxResponseStatusExceptionHandler (0), which would answer with an empty body.
 */
@Component
@Order(-2)
internal class ProblemErrorWebExceptionHandler(
    private val problems: ProblemFactory,
    private val jsonMapper: JsonMapper,
    private val log: AppLogger,
) : ErrorWebExceptionHandler {

    override fun handle(exchange: ServerWebExchange, ex: Throwable): Mono<Void> {
        if (exchange.response.isCommitted) return Mono.error(ex) // too late for a body: the connection is closed
        val headers = exchange.response.headers
        val model = when (ex) {
            is DomainException -> {
                log.info(REJECTED, exchange.problemFields(ex.errorCode.status, ex.errorCode, "error.message" to ex.message))
                problems.create(ex.errorCode, exchange, detail = ex.message ?: ex.errorCode.defaultMessage, params = ex.params)
            }
            is ResponseStatusException -> {
                val status = ex.statusCode.value()
                val code = problems.codeFor(status)
                val detail = "error.type" to ex.javaClass.simpleName
                if (ex.statusCode.is5xxServerError) {
                    log.error(FAILED, ex, exchange.problemFields(status, code, detail))
                    exchange.recordServerError(ex)
                } else {
                    log.info(REJECTED, exchange.problemFields(status, code, detail))
                }
                headers.addAll(ex.headers) // Allow (405), Accept (415) ...
                problems.create(problems.codeFor(status), exchange, status = status)
            }
            is AccessDeniedException -> {
                log.warn(REJECTED, exchange.problemFields(ErrorCode.FORBIDDEN.status, ErrorCode.FORBIDDEN))
                problems.create(ErrorCode.FORBIDDEN, exchange)
            }
            is AuthenticationException -> {
                log.debug(REJECTED, exchange.problemFields(ErrorCode.UNAUTHORIZED.status, ErrorCode.UNAUTHORIZED))
                problems.create(ErrorCode.UNAUTHORIZED, exchange)
            }
            else -> {
                // stack trace to the log, never to the client
                log.error(FAILED, ex, exchange.problemFields(ErrorCode.INTERNAL_ERROR.status, ErrorCode.INTERNAL_ERROR))
                exchange.recordServerError(ex)
                problems.create(ErrorCode.INTERNAL_ERROR, exchange)
            }
        }
        if (model.status == ErrorCode.UNAUTHORIZED.status) headers.set(HttpHeaders.WWW_AUTHENTICATE, "Bearer")
        if (ex is RateLimitedException) headers.set(HttpHeaders.RETRY_AFTER, ex.retryAfterSeconds.toString())
        return exchange.writeProblem(model, jsonMapper)
    }

    private companion object {
        const val REJECTED = "request rejected outside a controller"
        const val FAILED = "request failed outside a controller"
    }
}
