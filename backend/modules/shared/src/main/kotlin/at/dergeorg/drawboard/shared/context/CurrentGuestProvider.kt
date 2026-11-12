package at.dergeorg.drawboard.shared.context

import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * A guest as plain data - modules use this, never Spring Security types. A guest is a visitor without an account who
 * opened a `GUESTS` share link (S1): their identity is the guest token the application signed for the link (S1.3).
 * The claims below are those of the token; whether the link still works is NOT in it - ask the library (S1.13).
 *
 * [id] is the random part of `sub` (`guest:<id>`), [resourceKind] is `BOARD` or `FOLDER`, [role] the role of the link
 * at issue time, [authTime] the first exchange of the session (S1.4: 12 hours at most from here).
 */
data class CurrentGuest(
    val id: Uuid,
    val shareId: Uuid,
    val resourceKind: String,
    val resourceId: Uuid,
    val role: String,
    val name: String,
    val authTime: Instant,
    val tokenExpiresAt: Instant,
    val passwordVerified: Boolean,
)

/** The guest of the current request; implemented in core (Spring Security). Same caveat as [CurrentUserProvider]. */
interface CurrentGuestProvider {

    /** null unless the request carries a valid guest token (a signed-in user is not a guest). */
    suspend fun currentGuestOrNull(): CurrentGuest?
}
