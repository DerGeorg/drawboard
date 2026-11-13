package at.dergeorg.drawboard.library.common

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Limits of the link exchange (S7.3), bound from `library.*` (environment `LIBRARY_EXCHANGES_PER_MINUTE`, ...).
 *
 * @param exchangesPerMinute every exchange or refresh attempt of one client address (IPv6 by /64), whatever its outcome
 *   - a valid token is no free pass to hammer the endpoint.
 * @param passwordChecksPerMinute every password VERIFICATION (the Argon2 work, correct ones included) per link and client address.
 * @param templateListsPerMinute calls of listTemplates per user (each one resolves the access of up to 1000 candidates).
 */
@ConfigurationProperties("library")
internal data class LibraryProperties(
    val exchangesPerMinute: Int = 30,
    val passwordChecksPerMinute: Int = 10,
    val templateListsPerMinute: Int = 30,
) {
    init {
        require(exchangesPerMinute >= 1 && passwordChecksPerMinute >= 1 && templateListsPerMinute >= 1) {
            "library rate limits must be positive"
        }
    }
}
