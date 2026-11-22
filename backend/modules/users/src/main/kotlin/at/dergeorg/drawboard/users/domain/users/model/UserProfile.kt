package at.dergeorg.drawboard.users.domain.users.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * What this application knows about a user who signed in: our own [id] (UUIDv7, assigned at the first login) plus
 * a copy of the identity and claims of the access token. The OIDC provider stays the source of truth for
 * [username], [displayName], [email] and [groups]; they are refreshed at every login.
 *
 * ([issuer], [subject]) is the login key and unique: `sub` alone is not a UUID with every provider, and a user must
 * keep the same [id] when their username changes. [email] is only stored when the provider marked it verified;
 * [theme] is the user's own choice and never touched by a login; [groups] are display-only - every decision (e.g. instance admin) uses the groups of the CURRENT token, never these.
 * [version] is the optimistic lock.
 */
data class UserProfile(
    val id: Uuid,
    val issuer: String,
    val subject: String,
    val username: String,
    val displayName: String?,
    val email: String?,
    val groups: List<String>,
    val firstLoginAt: Instant,
    val lastLoginAt: Instant,
    val theme: ColorTheme = ColorTheme.SYSTEM,
    val version: Long = 0,
)
