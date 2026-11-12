package at.dergeorg.drawboard.api.common

import org.springframework.boot.context.properties.ConfigurationProperties
import java.net.URI
import java.net.URISyntaxException

/**
 * Settings of this deployment that are about the browser's view of it, bound from `drawboard.*`.
 *
 * @param publicUrl `DRAWBOARD_PUBLIC_URL`, REQUIRED (the application does not start without it): the origin the
 *   frontend is served from, e.g. `https://drawboard.example.org`. A WebSocket handshake is only accepted when its
 *   `Origin` header equals this value exactly (S2.2) - the one protection against another site opening the
 *   collaboration socket with the user's tickets. So it must BE an origin: scheme `http` or `https`, a host and
 *   optionally a port (a default port 80/443 is dropped, as browsers do in `Origin`) - no path, query, fragment or user info, no wildcard. One trailing slash is ignored. Anything
 *   else stops the start with a message that says what is wrong.
 * @param userSearch `DRAWBOARD_USER_SEARCH`, `all` (default) or `off`: whether the member picker may search users.
 * @param guestsEnabled `DRAWBOARD_GUESTS_ENABLED`, default false: whether links for guests without an account work.
 * @param trashRetentionDays `DRAWBOARD_TRASH_RETENTION_DAYS`, default 30 (S7.7): a deleted board or folder is purged this many
 *   days after the deletion, with its log, snapshots, grants and links.
 * @param trashCleanupSeconds `DRAWBOARD_TRASH_CLEANUP_SECONDS`, default 3600: how often the cleanup job looks.
 */
@ConfigurationProperties("drawboard")
internal data class DrawboardProperties(
    val publicUrl: String,
    val userSearch: String = "all",
    val guestsEnabled: Boolean = false,
    val trashRetentionDays: Long = 30,
    val trashCleanupSeconds: Long = 3600,
) {
    init {
        require(trashRetentionDays >= 0 && trashCleanupSeconds >= 1) { "the trash retention and cleanup interval must be positive" }
    }


    /** `DRAWBOARD_USER_SEARCH=all|off` (S6.10): off answers every search with an empty list. */
    val userSearchEnabled: Boolean = when (userSearch.trim().lowercase()) {
        "all", "" -> true
        "off" -> false
        else -> throw IllegalArgumentException("DRAWBOARD_USER_SEARCH must be all or off")
    }


    /** [publicUrl] as an `Origin` header value: lower-case scheme and host, no trailing slash. */
    val origin: String = parseOrigin(publicUrl)

    private companion object {
        const val MAX_PORT = 65_535
        const val HTTP_PORT = 80
        const val HTTPS_PORT = 443

        @Suppress("ThrowsCount")
        fun parseOrigin(publicUrl: String): String {
            val value = publicUrl.trim()
            require(value.isNotBlank()) { "DRAWBOARD_PUBLIC_URL must be set: the WebSocket handshake compares the Origin header with it" }
            val uri = try {
                URI(value)
            } catch (_: URISyntaxException) {
                throw IllegalArgumentException(
                    "DRAWBOARD_PUBLIC_URL is not a valid URL; expected an origin like https://drawboard.example.org",
                )
            }
            val scheme = uri.scheme?.lowercase()
            require(scheme == "http" || scheme == "https") { "DRAWBOARD_PUBLIC_URL must start with http:// or https://" }
            require(!uri.host.isNullOrEmpty()) { "DRAWBOARD_PUBLIC_URL must contain a host" }
            require(uri.rawUserInfo == null) { "DRAWBOARD_PUBLIC_URL must not contain user info (user:password@)" }
            require(uri.port == -1 || uri.port in 1..MAX_PORT) { "DRAWBOARD_PUBLIC_URL has an invalid port" }
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "DRAWBOARD_PUBLIC_URL must not contain a path: it is an origin" }
            require(uri.rawQuery == null) { "DRAWBOARD_PUBLIC_URL must not contain a query" }
            require(uri.rawFragment == null) { "DRAWBOARD_PUBLIC_URL must not contain a fragment" }
            // browsers leave the default port out of Origin, so https://host:443 must become https://host
            val defaultPort = if (scheme == "https") HTTPS_PORT else HTTP_PORT
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            return "$scheme://${uri.host.lowercase()}$port"
        }
    }
}
