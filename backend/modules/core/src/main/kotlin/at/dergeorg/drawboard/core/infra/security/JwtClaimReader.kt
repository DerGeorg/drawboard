package at.dergeorg.drawboard.core.infra.security

import org.springframework.security.oauth2.jwt.Jwt

/** Reads claims of a token by the names the deployment configured (`OIDC_CLAIM_*`). */
internal object JwtClaimReader {

    /**
     * The value at [path]: a claim with exactly this name, otherwise a dot path through nested objects
     * (`resource_access.drawboard-api.roles`). null if nothing is there.
     */
    fun value(jwt: Jwt, path: String): Any? {
        if (jwt.hasClaim(path)) return jwt.claims[path]
        val segments = path.split('.').filter { it.isNotEmpty() }
        if (segments.size < 2) return null
        return segments.drop(1).fold(jwt.claims[segments.first()]) { current, segment -> (current as? Map<*, *>)?.get(segment) }
    }

    /** The text at [path], or null if it is missing, blank or not text. */
    fun text(jwt: Jwt, path: String): String? = (value(jwt, path) as? String)?.takeIf { it.isNotBlank() }

    /**
     * The values at [path] as a set: a JSON array of strings, or one string (split at spaces and commas - some
     * providers send `"a b"` or `"a,b"`). Everything else, and blanks, are ignored.
     */
    fun texts(jwt: Jwt, path: String): Set<String> = when (val claim = value(jwt, path)) {
        is Collection<*> -> claim.filterIsInstance<String>()
        is String -> claim.split(' ', ',')
        else -> emptyList()
    }.filter { it.isNotBlank() }.toSet()
}
