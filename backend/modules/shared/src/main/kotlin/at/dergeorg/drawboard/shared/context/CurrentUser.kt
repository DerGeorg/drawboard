package at.dergeorg.drawboard.shared.context

import kotlin.time.Instant

/**
 * The signed-in user as plain data - modules use this, never Spring Security types.
 *
 * The identity is [issuer] + [subject] (claims `iss` and `sub` of the access token): together they are stable and
 * unique, but `sub` alone is not a UUID with every OIDC provider. The application's own user id (a UUID assigned at
 * the first login) lives in the `users` module. [username], [displayName], [email] and [groups] can change at the
 * provider and are copies for display and for the admin check.
 *
 * Which claims carry username and groups is configuration (core, `OIDC_CLAIM_*`). [admin] is true when [groups]
 * contains the configured admin group of this deployment (`DRAWBOARD_ADMIN_GROUP`); it says nothing about boards.
 * [tokenExpiresAt] is the `exp` of the access token of THIS request - the collaboration ticket is bound to it.
 */
data class CurrentUser(
    val issuer: String,
    val subject: String,
    val username: String,
    val displayName: String? = null,
    val email: String? = null,
    val groups: Set<String> = emptySet(),
    val admin: Boolean = false,
    val tokenExpiresAt: Instant? = null,
)
