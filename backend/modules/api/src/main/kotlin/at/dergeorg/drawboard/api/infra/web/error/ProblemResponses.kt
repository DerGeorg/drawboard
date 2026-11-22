package at.dergeorg.drawboard.api.infra.web.error

import at.dergeorg.drawboard.shared.observability.TracedPaths
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.micrometer.tracing.handler.TracingObservationHandler.TracingContext
import org.springframework.http.HttpStatusCode
import org.springframework.http.MediaType
import org.springframework.http.server.reactive.observation.ServerRequestObservationContext
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono
import tools.jackson.databind.json.JsonMapper

/**
 * Records a HANDLED server error on the HTTP server observation. Spring only sees exceptions that escape; one that
 * our handlers turned into a 500 would otherwise leave `exception="none"` on `http.server.requests` and the HTTP
 * server span without error status. The context's error feeds the metric tag; the span needs it explicitly (the
 * tracing handler only reads errors signalled through `Observation.error`). Client errors (4xx) are expected
 * outcomes and are not recorded.
 */
internal fun ServerWebExchange.recordServerError(error: Throwable) {
    ServerRequestObservationContext.findCurrent(attributes).ifPresent { context ->
        context.setError(error)
        context.get<TracingContext>(TracingContext::class.java)?.span?.error(error)
    }
}

/**
 * Writes [model] as `application/problem+json` straight into the response - for the places outside the controller
 * world (security filter chain, WebExceptionHandler), where no ResponseEntity is rendered.
 */
internal fun ServerWebExchange.writeProblem(model: ErrorModel, jsonMapper: JsonMapper): Mono<Void> {
    val response = response
    response.statusCode = HttpStatusCode.valueOf(model.status)
    response.headers.contentType = MediaType.APPLICATION_PROBLEM_JSON
    return response.writeWith(Mono.fromSupplier { response.bufferFactory().wrap(jsonMapper.writeValueAsBytes(model)) })
}

/**
 * The fields of the one log line per error response: the request and the outcome as ECS fields
 * (`http.request.method`, `url.path`, `http.response.status_code`, `error.code`) plus one optional [detail]
 * (`error.message` of our own text, or `error.type` - never the message of a framework exception, which can echo
 * the rejected input). Request id, trace id and span id come from the MDC. The caller picks the level:
 * `log.info(...)` for client errors, `log.debug` for 401, `log.warn` for 403, `log.error` with the cause for 5xx.
 */
internal fun ServerWebExchange.problemFields(
    status: Int,
    code: ErrorCode,
    detail: Pair<String, Any?>? = null,
): Map<String, Any?> = buildMap {
    put("http.request.method", request.method.name())
    put("url.path", TracedPaths.mask(request.path.value())) // no card of a placement or an estimate next to the caller (B1)
    put("http.response.status_code", status)
    put("error.code", code.name)
    detail?.let { (key, value) -> put(key, value) }
}
