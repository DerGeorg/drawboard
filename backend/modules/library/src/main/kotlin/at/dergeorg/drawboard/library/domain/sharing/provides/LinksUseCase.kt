package at.dergeorg.drawboard.library.domain.sharing.provides

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.model.CreatedLink
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeOutcome
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Share links to boards and folders (S1). Creating, listing and revoking is the owner's alone (a caller without a role
 * gets "not found", a weaker role 403). Every change and every exchange is audited in the same transaction.
 */
interface LinksUseCase {

    /**
     * Creates a link with a fresh 256-bit token (S1.1); the token is in the result and nowhere else. The role is
     * `EDITOR`, `COMMENTER` or `VIEWER` (S1.15), a password has at least 8 characters (S1.11), an expiry lies in the future.
     */
    suspend fun createLink(command: CreateLinkCommand): CreatedLink

    /** All links of the resource, newest first, also revoked and expired ones. Owner only. */
    suspend fun listLinks(caller: Caller, kind: ResourceKind, resourceId: Uuid): List<ShareLink>

    /** Revokes a link and ends the access it remembered for signed-in users. Idempotent. Owner only. */
    suspend fun revokeLink(caller: Caller, linkId: Uuid): RevokedLink

    /**
     * Opens a link (S1.2, S1.11, S1.12): finds it by the hash of the token and decides what the caller gets. A failure
     * is a value ([ExchangeOutcome.Failed]), never an exception - its audit event is committed with the call. Unknown,
     * revoked and expired tokens are one failure. Rate limits: 10 invalid tokens per minute and IP; 5 wrong passwords
     * per minute per link and IP and 20 per hour per link, growing delay, never locked.
     */
    suspend fun exchange(command: ExchangeCommand): ExchangeOutcome

    /**
     * The guest identity a guest token of [shareId] stands for RIGHT NOW (S1.13): null once the link is revoked,
     * expired or its resource is gone. The answer is cached for at most 30 seconds.
     */
    suspend fun guestCaller(shareId: Uuid): Caller.Guest?

    /**
     * Checks a refresh (S1.4): [token] must be the token of link [shareId]; revoked, expired or unknown is the same
     * `Failed(NOT_FOUND)` as on exchange. The password is not asked again - the guest session proves it.
     */
    suspend fun checkRefresh(shareId: Uuid, token: String, ip: String): ExchangeOutcome
}

data class CreateLinkCommand(
    val caller: Caller,
    val kind: ResourceKind,
    val resourceId: Uuid,
    val role: BoardRole,
    val audience: ShareAudience,
    val expiresAt: Instant?,
    val password: String?,
)

/** [token] is the link token as the visitor holds it, [caller] the signed-in user or null for an anonymous visitor. */
class ExchangeCommand(
    val token: String,
    val password: String?,
    val caller: Caller.User?,
    val ip: String,
    val guestsEnabled: Boolean,
    /** The sanitised display name an anonymous visitor wants as a guest; null if they gave none. */
    val guestName: String? = null,
) {
    override fun toString() = "ExchangeCommand(ip=$ip)" // never the token or the password
}

/** What was revoked: the resource, so the caller can tell the collaboration. */
data class RevokedLink(val kind: ResourceKind, val resourceId: Uuid)
