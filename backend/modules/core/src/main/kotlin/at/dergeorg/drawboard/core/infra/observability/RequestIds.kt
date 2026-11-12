package at.dergeorg.drawboard.core.infra.observability

import kotlin.uuid.Uuid

/**
 * Which request id a request gets: a valid inbound `X-Request-Id` (a proxy or client may choose it), otherwise the
 * trace id - so for our own requests the request id in logs, audit rows and error bodies IS the id to search in
 * Tempo. A random Uuid only when tracing is off.
 */
internal object RequestIds {

    /** Letters, digits and `._:-`, 8..64 characters: nothing that could inject into logs or headers. */
    private val VALID = Regex("^[A-Za-z0-9._:-]{8,64}$")

    fun resolve(inbound: String?, traceId: String?): String = when {
        inbound != null && VALID.matches(inbound) -> inbound
        traceId != null && traceId.any { it != '0' } -> traceId
        else -> Uuid.random().toString()
    }
}
