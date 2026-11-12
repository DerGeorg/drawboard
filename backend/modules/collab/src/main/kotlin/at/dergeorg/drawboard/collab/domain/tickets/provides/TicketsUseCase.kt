package at.dergeorg.drawboard.collab.domain.tickets.provides

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Tickets that open the WebSocket (S2.1). The caller has checked that the user may see the board. */
interface TicketsUseCase {

    /** `TOO_MANY_REQUESTS` (429, [at.dergeorg.drawboard.shared.error.RateLimitedException]) after 60 tickets per minute and user. */
    suspend fun issue(command: IssueTicketCommand): IssuedTicket
}

/** [tokenExpiresAt]: the `exp` of the access token the ticket is issued with - the session ends then at the latest. */
data class IssueTicketCommand(
    val userId: Uuid,
    val boardId: Uuid,
    val displayName: String,
    val tokenExpiresAt: Instant,
    /** The groups of that token (S6.5). */
    val groups: Set<String> = emptySet(),
    /** Set for a guest: the share link they came through. */
    val shareId: Uuid? = null,
)

/** The ticket text (256 bit, base64url) and the instant after which it is worthless. */
data class IssuedTicket(val ticket: String, val expiresAt: Instant)
