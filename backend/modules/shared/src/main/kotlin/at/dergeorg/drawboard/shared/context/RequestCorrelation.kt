package at.dergeorg.drawboard.shared.context

/**
 * Names under which the correlation ids of a request travel. One place, because the request-id filter (core),
 * the error bodies (api) and auditing must agree on them.
 *
 * The request id is the inbound `X-Request-Id` if the caller sent a valid one, otherwise the trace id.
 */
object RequestCorrelation {
    const val REQUEST_ID_HEADER = "X-Request-Id"

    /** MDC key, Reactor context key and exchange attribute of the request id (the ECS log field is `requestId`). */
    const val REQUEST_ID_KEY = "requestId"

    /** Exchange attribute of the trace id of the HTTP server span. */
    const val TRACE_ID_KEY = "traceId"

    /** Reactor context key and exchange attribute of the client address (S7.3, see `ClientAddressProvider`). */
    const val CLIENT_IP_KEY = "clientIp"

    /** Span attribute carrying the request id on every span (Tempo: `{ span.request.id = "..." }`). */
    const val REQUEST_ID_SPAN_ATTRIBUTE = "request.id"
}
