package at.dergeorg.drawboard.shared.security

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** What goes into a guest token (S1.3). [kind] is `BOARD` or `FOLDER`, [role] a role name (never OWNER). */
data class GuestTokenRequest(
    val guestId: Uuid,
    val shareId: Uuid,
    val kind: String,
    val resourceId: Uuid,
    val role: String,
    val name: String,
    val passwordVerified: Boolean,
    /** The first exchange of the session; the token and every renewal end at the latest 12 hours after it (S1.4). */
    val authTime: Instant,
    /** Expiry of the link, if it has one: the token never outlives it. */
    val shareExpiresAt: Instant?,
)

/** A signed guest token and its expiry: at most 15 minutes, never beyond the link or the 12 hour limit. */
data class IssuedGuestToken(val token: String, val expiresAt: Instant)

/** Signs guest tokens with the application's own key (S1.3, S1.5). Implemented in core. */
interface GuestTokenIssuer {

    /** The longest a guest session may last from [GuestTokenRequest.authTime] (S1.4). */
    val sessionLimitHours: Long get() = SESSION_LIMIT_HOURS

    /** @throws IllegalStateException when guests are not configured, or the session has no lifetime left. */
    fun issue(request: GuestTokenRequest): IssuedGuestToken

    companion object {
        const val SESSION_LIMIT_HOURS = 12L
        const val TOKEN_MINUTES = 15L
    }
}
