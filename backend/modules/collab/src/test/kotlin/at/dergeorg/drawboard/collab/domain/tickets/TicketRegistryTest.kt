package at.dergeorg.drawboard.collab.domain.tickets

import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.tickets.provides.IssueTicketCommand
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class TicketRegistryTest {

    private val clock = MutableClock()
    private val registry = TicketRegistry(CollabLimits(), clock)
    private val user = Uuid.random()
    private val board = Uuid.random()
    private val tokenExp = FIXED_NOW + 300.seconds

    private fun issue(userId: Uuid = user, boardId: Uuid = board) =
        registry.issue(IssueTicketCommand(userId, boardId, "Alice", tokenExp))

    @Nested
    inner class Issue {

        @Test
        fun `when issuing then the ticket is 43 characters of base64url and valid for 30 seconds`() {
            val issued = issue()

            assertTrue(Regex("[A-Za-z0-9_-]{43}").matches(issued.ticket), "256 bit, base64url without padding: ${issued.ticket}")
            assertEquals(FIXED_NOW + 30.seconds, issued.expiresAt, "expiry")
        }

        @Test
        fun `when issuing twice then the tickets differ`() {
            assertNotEquals(issue().ticket, issue().ticket, "random")
        }

        @Test
        fun `when issuing the 61st ticket within a minute then it is rate limited with the seconds to wait`() {
            repeat(60) { issue() }

            val rejected = assertFailsWith<RateLimitedException>("61st ticket") { issue() }

            assertEquals(ErrorCode.TOO_MANY_REQUESTS, rejected.errorCode, "error code")
            assertTrue(rejected.retryAfterSeconds in 1..60, "retry after ${rejected.retryAfterSeconds}s")
        }

        @Test
        fun `when the limit is used up then another user is not affected and the same user may continue after a minute`() {
            repeat(60) { issue() }

            assertNotNull(issue(userId = Uuid.random()), "another user")
            clock.advanceBy(61.seconds)
            assertNotNull(issue(), "after the refill")
        }
    }

    @Nested
    inner class Redeem {

        @Test
        fun `when redeeming then the claims of the issue come back and the ticket is used up`() {
            val issued = issue()

            val claims = assertNotNull(registry.redeem(issued.ticket, board), "first redeem")
            assertEquals(TicketClaims(user, board, "Alice", tokenExp), claims, "claims bound at issue")
            assertNull(registry.redeem(issued.ticket, board), "second redeem")
        }

        @Test
        fun `when redeeming after 30 seconds then it is expired`() {
            val issued = issue()
            clock.advanceBy(30.seconds)

            assertNull(registry.redeem(issued.ticket, board), "expired")
        }

        @Test
        fun `when redeeming for another board or an unknown ticket then nothing comes back and the ticket is burned`() {
            val issued = issue()

            assertNull(registry.redeem(issued.ticket, Uuid.random()), "other board")
            assertNull(registry.redeem(issued.ticket, board), "burned by the failed attempt")
            assertNull(registry.redeem("A".repeat(43), board), "unknown")
        }
    }
}
