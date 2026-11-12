package at.dergeorg.drawboard.collab.domain.tickets

import at.dergeorg.drawboard.collab.domain.ratelimit.UserRateLimiter
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssuedTicket
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** What a redeemed ticket proves. */
internal data class TicketClaims(
    val userId: Uuid,
    val boardId: Uuid,
    val displayName: String,
    val tokenExpiresAt: Instant,
    val groups: Set<String> = emptySet(),
    val shareId: Uuid? = null,
)

/**
 * One-time tickets in memory: 256 bit from [SecureRandom], base64url without padding (43 characters), valid
 * [CollabLimits.ticketSeconds], redeemable once, bound to user, board, display name and the token's `exp` (S2.1).
 * Issuing is limited to [CollabLimits.ticketsPerMinute] per user (Bucket4j, S7.3).
 *
 * In memory means: a restart invalidates open tickets (clients simply fetch a new one), and a second replica could
 * not redeem a ticket the first one issued - fine for the single replica of M1, see [CollabUseCase].
 */
internal class TicketRegistry(private val limits: CollabLimits, private val clock: Clock) {

    private class Entry(val claims: TicketClaims, val expiresAt: Instant)

    private val perUser = UserRateLimiter(limits.ticketsPerMinute, clock)

    private val random = SecureRandom()
    private val tickets = ConcurrentHashMap<String, Entry>()

    @Volatile
    private var lastPurge: Instant = Instant.DISTANT_PAST

    fun issue(command: IssueTicketCommand): IssuedTicket {
        val now = clock.now()
        purge(now)
        perUser.take(command.userId)
        val ticket = ByteArray(TICKET_BYTES).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        val expiresAt = now + limits.ticketSeconds.seconds
        tickets[ticket] = Entry(
            TicketClaims(command.userId, command.boardId, command.displayName, command.tokenExpiresAt, command.groups, command.shareId),
            expiresAt,
        )
        return IssuedTicket(ticket, expiresAt)
    }

    /** Uses the ticket up (atomic remove). Null if it is unknown, used, expired or was issued for another board. */
    fun redeem(ticket: String, boardId: Uuid): TicketClaims? {
        val entry = tickets.remove(ticket) ?: return null
        if (clock.now() >= entry.expiresAt || entry.claims.boardId != boardId) return null
        return entry.claims
    }

    /** Drops expired tickets, at most every [PURGE_SECONDS]; called when a ticket is issued. */
    private fun purge(now: Instant) {
        if (now - lastPurge < PURGE_SECONDS.seconds) return
        lastPurge = now
        tickets.values.removeIf { now >= it.expiresAt }
    }

    private companion object {
        const val TICKET_BYTES = 32
        const val PURGE_SECONDS = 30L
    }
}
