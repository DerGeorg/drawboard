package at.dergeorg.drawboard.shared.context

/**
 * The address of the client of the current request, for rate limits and audit events (S7.3). Implemented in core: it
 * is the socket address, or - only when the direct peer is a configured trusted proxy (`DRAWBOARD_TRUSTED_PROXIES`) -
 * the rightmost `X-Forwarded-For` entry that is not itself a trusted proxy. Same caveat as [CurrentUserProvider].
 */
interface ClientAddressProvider {

    /** The address as text, or [UNKNOWN] outside a request. */
    suspend fun clientAddress(): String

    companion object {
        const val UNKNOWN = "unknown"
    }
}
