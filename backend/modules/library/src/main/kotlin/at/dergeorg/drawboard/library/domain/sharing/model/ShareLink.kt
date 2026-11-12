package at.dergeorg.drawboard.library.domain.sharing.model

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Who may open a link. Same names as `ShareAudience` of the API contract. */
enum class ShareAudience {
    /** Anyone signed in with the link (the default). */
    SIGNED_IN,

    /** Also people without an account - they become guests (S1.14, explicit opt-in). */
    GUESTS,
}

/**
 * A link to a board or folder. The token itself is never stored, only [tokenHash] = sha256(token) (S1.1). [role] is
 * never `OWNER` (S1.15). [passwordHash] is an Argon2 hash (S1.11). A link is usable while it is neither revoked nor
 * expired; [useCount] counts successful exchanges.
 */
data class ShareLink(
    val id: Uuid,
    val resourceKind: ResourceKind,
    val resourceId: Uuid,
    val role: BoardRole,
    val audience: ShareAudience,
    val tokenHash: String,
    val passwordHash: String?,
    val expiresAt: Instant?,
    val revokedAt: Instant?,
    val useCount: Long,
    val createdAt: Instant,
    val createdBy: Uuid,
) {
    init {
        require(role != BoardRole.OWNER) { "a link never grants OWNER" }
    }

    val passwordProtected: Boolean get() = passwordHash != null

    fun usable(now: Instant): Boolean = revokedAt == null && (expiresAt == null || now < expiresAt)
}

/** A freshly created link together with its token - the only moment the token exists in clear text. */
data class CreatedLink(val link: ShareLink, val token: String)

/** How an exchange ended (successfully or not). Failures are values, not exceptions: the audit event must be committed. */
sealed interface ExchangeOutcome {

    /** A signed-in user opened the link: the role is remembered for them. [role] is their effective role. */
    data class SignedIn(val kind: ResourceKind, val resourceId: Uuid, val role: BoardRole) : ExchangeOutcome

    /** An anonymous visitor may become a guest of [shareId]. */
    data class Guest(
        val shareId: Uuid,
        val kind: ResourceKind,
        val resourceId: Uuid,
        val role: BoardRole,
        val shareExpiresAt: Instant?,
        val passwordVerified: Boolean,
    ) : ExchangeOutcome

    data class Failed(val reason: ExchangeFailure, val retryAfterSeconds: Long = 0) : ExchangeOutcome
}

enum class ExchangeFailure {
    /** Unknown, revoked and expired tokens - deliberately one reason (S1.12). */
    NOT_FOUND,
    LOGIN_REQUIRED,
    PASSWORD_REQUIRED,
    PASSWORD_INVALID,
    RATE_LIMITED,

    /** An anonymous visitor on a guest link has not said who they are (checked after the link and the password). */
    NAME_REQUIRED,
}
