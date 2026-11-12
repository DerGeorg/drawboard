package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.security.oauth2.core.OAuth2AuthenticationException
import org.springframework.security.web.server.ServerAuthenticationEntryPoint
import org.springframework.security.web.server.authorization.ServerAccessDeniedHandler
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import tools.jackson.databind.json.JsonMapper

/**
 * 401 and 403 raised by the security filter chain happen before any controller, so the controller advice never
 * sees them. This handler writes the same ErrorModel instead of an empty body. Core's SecurityConfig wires it in
 * (by its Spring Security interfaces - core does not know this class).
 *
 * Challenges per RFC 6750: `Bearer` without a token, `error="invalid_token"` for a broken or expired one,
 * `error="insufficient_scope"` for a missing permission.
 */
@Component
internal class SecurityProblemHandler(
    private val problems: ProblemFactory,
    private val jsonMapper: JsonMapper,
    private val log: AppLogger,
) : ServerAuthenticationEntryPoint, ServerAccessDeniedHandler {

    override fun commence(exchange: ServerWebExchange, exception: AuthenticationException): Mono<Void> {
        val code = ErrorCode.UNAUTHORIZED
        log.debug(REJECTED, exchange.problemFields(code.status, code, "error.type" to exception.javaClass.simpleName))
        val challenge = if (exception is OAuth2AuthenticationException) """Bearer error="invalid_token"""" else "Bearer"
        exchange.response.headers.set(HttpHeaders.WWW_AUTHENTICATE, challenge)
        return write(exchange, HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED)
    }

    override fun handle(exchange: ServerWebExchange, denied: AccessDeniedException): Mono<Void> {
        log.warn(REJECTED, exchange.problemFields(ErrorCode.FORBIDDEN.status, ErrorCode.FORBIDDEN))
        exchange.response.headers.set(HttpHeaders.WWW_AUTHENTICATE, """Bearer error="insufficient_scope"""")
        return write(exchange, HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN)
    }

    private fun write(exchange: ServerWebExchange, status: HttpStatus, code: ErrorCode): Mono<Void> =
        exchange.writeProblem(problems.create(code, exchange, status = status.value()), jsonMapper)

    private companion object {
        const val REJECTED = "request rejected by the route table"
    }
}
