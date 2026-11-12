package at.dergeorg.drawboard.library.domain.sharing

import at.dergeorg.drawboard.library.common.LibraryProperties
import at.dergeorg.drawboard.library.domain.FakePasswordHasher
import at.dergeorg.drawboard.library.domain.InMemoryBoardRepository
import at.dergeorg.drawboard.library.domain.InMemoryFolderRepository
import at.dergeorg.drawboard.library.domain.InMemoryGrantRepository
import at.dergeorg.drawboard.library.domain.InMemoryShareLinkRepository
import at.dergeorg.drawboard.library.domain.RecordingShareMetrics
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeFailure
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeOutcome
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.provides.CreateLinkCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.ExchangeCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.impl.LinksService
import at.dergeorg.drawboard.library.testing.BoardFixtures.BOARD
import at.dergeorg.drawboard.library.testing.BoardFixtures.OWNER
import at.dergeorg.drawboard.library.testing.BoardFixtures.STRANGER
import at.dergeorg.drawboard.library.testing.BoardFixtures.aBoard
import at.dergeorg.drawboard.library.testing.BoardFixtures.asUser
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class LinksServiceTest {

    private val clock = MutableClock()
    private val audit = RecordingAuditTrail()
    private val boards = InMemoryBoardRepository(aBoard())
    private val folders = InMemoryFolderRepository()
    private val grants = InMemoryGrantRepository()
    private val links = InMemoryShareLinkRepository()
    private val metrics = RecordingShareMetrics()
    private val access = AccessResolver(folders, grants, links, clock)
    private val service = LinksService(links, boards, folders, grants, access, FakePasswordHasher(), metrics, LibraryProperties(),
        audit, clock)

    private suspend fun create(
        role: BoardRole = BoardRole.VIEWER,
        audience: ShareAudience = ShareAudience.SIGNED_IN,
        password: String? = null,
    ) = service.createLink(CreateLinkCommand(asUser(OWNER), ResourceKind.BOARD, BOARD, role, audience, null, password))

    private suspend fun open(token: String, password: String? = null, signedIn: Boolean = true, ip: String = "198.51.100.7",
        guests: Boolean = true) =
        service.exchange(ExchangeCommand(token, password, if (signedIn) asUser(STRANGER) else null, ip, guests, guestName = "Gus"))

    @Nested
    inner class Create {

        @Test
        fun `when creating then only the sha256 of the token is stored, the token is in the result once`() = runTest {
            val created = create()

            assertEquals(ShareTokens.hash(created.token), links.all.single().tokenHash, "stored: the hash")
            assertTrue(links.all.none { created.token in it.toString() }, "the token is nowhere in the stored link")
            assertEquals(43, created.token.length, "256 bit as base64url")
        }

        @Test
        fun `when creating with a password then it is stored as a hash, never in the audit event`() = runTest {
            val created = create(password = "s3cret-pass")

            assertEquals("hashed:s3cret-pass", links.all.single().passwordHash, "hash stored")
            assertTrue(created.link.passwordProtected, "protected")
            assertTrue(audit.events.all { "s3cret-pass" !in it.toString() && created.token !in it.toString() },
                "no password or token in the audit")
        }

        @Test
        fun `when the password is shorter than eight characters then VALIDATION_FAILED`() = runTest {
            assertFailsWith<ValidationFailedException>("7 characters") { create(password = "1234567") }
        }

        @Test
        fun `when the role is OWNER then it is refused, and when the expiry is in the past too`() = runTest {
            assertFailsWith<ValidationFailedException>("owner") { create(role = BoardRole.OWNER) }
            assertFailsWith<ValidationFailedException>("past expiry") {
                service.createLink(CreateLinkCommand(asUser(OWNER), ResourceKind.BOARD, BOARD, BoardRole.VIEWER,
                    ShareAudience.SIGNED_IN, clock.now() - 1.hours, null))
            }
        }

        @Test
        fun `when a stranger creates a link then LIBRARY_BOARD_NOT_FOUND`() = runTest {
            val failure = assertFailsWith<DomainException>("no role") {
                service.createLink(CreateLinkCommand(asUser(STRANGER), ResourceKind.BOARD, BOARD, BoardRole.VIEWER,
                    ShareAudience.SIGNED_IN, null, null))
            }

            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, failure.errorCode, "existence is hidden")
        }

        @Test
        fun `when creating then share created and password set are audited`() = runTest {
            create(password = "s3cret-pass")

            assertEquals("library.share.created", audit.events.single().eventType, "event type")
        }
    }

    @Nested
    inner class ExchangeSignedIn {

        @Test
        fun `when a signed-in user opens a link then the role is remembered, the use counted and it is audited`() = runTest {
            val created = create(role = BoardRole.EDITOR)

            val outcome = open(created.token)

            assertIs<ExchangeOutcome.SignedIn>(outcome, "signed in")
            assertEquals(BoardRole.EDITOR, outcome.role, "role of the link")
            assertEquals(PrincipalKind.LINK_USER, grants.all.single().principalKind, "remembered as LINK_USER")
            assertEquals(1, links.all.single().useCount, "use count")
            assertEquals(listOf("library.share.created", "library.share.exchanged"), audit.events.map { it.eventType }, "audit")
            assertEquals(BoardRole.EDITOR, access.boardRole(boards.findById(BOARD)!!, asUser(STRANGER)), "and it works")
        }

        @Test
        fun `when the owner opens their own link then they stay OWNER and nothing is remembered`() = runTest {
            val created = create()

            val outcome = service.exchange(ExchangeCommand(created.token, null, asUser(OWNER), "198.51.100.7", false))

            assertEquals(BoardRole.OWNER, assertIs<ExchangeOutcome.SignedIn>(outcome, "signed in").role, "owner")
            assertTrue(grants.all.isEmpty(), "no grant for the owner")
        }

        @Test
        fun `when the link is revoked then the remembered access ends at once`() = runTest {
            val created = create()
            open(created.token)

            service.revokeLink(asUser(OWNER), created.link.id)

            assertNull(access.boardRole(boards.findById(BOARD)!!, asUser(STRANGER)), "revoked: no role any more")
            assertTrue(grants.all.isEmpty(), "grant removed")
        }

        @Test
        fun `when the link expires then the remembered access ends with it`() = runTest {
            val created = service.createLink(
                CreateLinkCommand(asUser(OWNER), ResourceKind.BOARD, BOARD, BoardRole.VIEWER, ShareAudience.SIGNED_IN,
                    clock.now() + 1.hours, null),
            )
            open(created.token)

            clock.advanceBy(2.hours)

            assertNull(access.boardRole(boards.findById(BOARD)!!, asUser(STRANGER)), "expired link, no role")
        }
    }

    @Nested
    inner class Failures {

        @Test
        fun `when the token is unknown, revoked or expired then the outcome is the same NOT_FOUND`() = runTest {
            val revoked = create().also { service.revokeLink(asUser(OWNER), it.link.id) }
            val expired = service.createLink(
                CreateLinkCommand(asUser(OWNER), ResourceKind.BOARD, BOARD, BoardRole.VIEWER, ShareAudience.SIGNED_IN,
                    clock.now() + 1.minutes, null),
            )
            clock.advanceBy(2.minutes)

            val outcomes = listOf(open("no-such-token"), open(revoked.token), open(expired.token))

            assertEquals(List(3) { ExchangeOutcome.Failed(ExchangeFailure.NOT_FOUND) }, outcomes, "one outcome, indistinguishable")
        }

        @Test
        fun `when the board is in the trash then the link answers NOT_FOUND`() = runTest {
            val created = create()
            boards.setDeletedAt(listOf(BOARD), clock.now())

            assertEquals(ExchangeOutcome.Failed(ExchangeFailure.NOT_FOUND), open(created.token), "trashed")
        }

        @Test
        fun `when ten invalid tokens came from one IP in a minute then the eleventh is RATE_LIMITED, other IPs are not affected`() =
            runTest {
            repeat(10) { open("bad-$it") }

            val blocked = open("bad-next")
            val other = open("bad-next", ip = "203.0.113.9")

            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(blocked, "blocked").reason, "429")
            assertTrue(blocked.retryAfterSeconds > 0, "with a Retry-After")
            assertEquals(ExchangeFailure.NOT_FOUND, assertIs<ExchangeOutcome.Failed>(other, "other IP").reason,
                "other IP still gets the 404")
        }

        @Test
        fun `when every failure happens then it is audited with the IP and without the token`() = runTest {
            open("no-such-token", ip = "198.51.100.7")

            val event = audit.events.single()
            assertEquals("library.share.exchange-failed", event.eventType, "event type")
            assertTrue("198.51.100.7" in event.details.toString() && "no-such-token" !in event.toString(), "IP yes, token no")
        }

        @Test
        fun `when anonymous opens a link for signed-in users then LOGIN_REQUIRED`() = runTest {
            val created = create()

            assertEquals(ExchangeOutcome.Failed(ExchangeFailure.LOGIN_REQUIRED), open(created.token, signedIn = false), "sign in first")
        }
    }

    @Nested
    inner class Passwords {

        @Test
        fun `when the password is missing then PASSWORD_REQUIRED and when it is wrong then PASSWORD_INVALID`() = runTest {
            val created = create(password = "right-password")

            assertEquals(ExchangeFailure.PASSWORD_REQUIRED, assertIs<ExchangeOutcome.Failed>(open(created.token), "none").reason,
                "missing")
            assertEquals(ExchangeFailure.PASSWORD_INVALID, assertIs<ExchangeOutcome.Failed>(open(created.token, "wrong-one"),
                "wrong").reason, "wrong")
            assertIs<ExchangeOutcome.SignedIn>(open(created.token, "right-password"), "the right one works")
        }

        @Test
        fun `when five wrong passwords came from one IP in a minute then the sixth is RATE_LIMITED, right password or not`() = runTest {
            val created = create(password = "right-password")
            repeat(5) { open(created.token, "wrong-$it") }

            val blocked = open(created.token, "right-password")

            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(blocked, "blocked").reason,
                "429 for the right password too")
        }

        @Test
        fun `when the minute has passed then the right password works again - the share is never locked for good`() = runTest {
            val created = create(password = "right-password")
            repeat(7) { open(created.token, "wrong-$it") }
            val during = assertIs<ExchangeOutcome.Failed>(open(created.token, "right-password"), "while blocked")

            clock.advanceBy((during.retryAfterSeconds + 1).seconds + 1.hours)

            assertIs<ExchangeOutcome.SignedIn>(open(created.token, "right-password"), "free again")
        }

        @Test
        fun `when attempts come from many IPs then 20 failures per hour block the whole share`() = runTest {
            val created = create(password = "right-password")
            repeat(20) { open(created.token, "wrong", ip = "10.0.0.$it") }

            val blocked = open(created.token, "right-password", ip = "10.9.9.9")

            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(blocked, "blocked").reason, "per-share limit")
        }

        @Test
        fun `when audited then wrong passwords leave failure events without the password`() = runTest {
            val created = create(password = "right-password")

            open(created.token, "guess-password")

            assertTrue(audit.events.last().let { "guess-password" !in it.toString() &&
                it.eventType == "library.share.exchange-failed" }, "failure audited, guess not")
        }
    }

    @Nested
    inner class Guests {

        @Test
        fun `when anonymous opens a GUESTS link with guests enabled then it is a guest outcome with the share's role`() = runTest {
            val created = create(role = BoardRole.COMMENTER, audience = ShareAudience.GUESTS)

            val outcome = open(created.token, signedIn = false)

            assertEquals(BoardRole.COMMENTER, assertIs<ExchangeOutcome.Guest>(outcome, "guest").role, "role")
            assertEquals(1, metrics.guestSessions, "guest session counted")
        }

        @Test
        fun `when guests are disabled on the instance then LOGIN_REQUIRED`() = runTest {
            val created = create(audience = ShareAudience.GUESTS)

            assertEquals(ExchangeOutcome.Failed(ExchangeFailure.LOGIN_REQUIRED), open(created.token, signedIn = false, guests = false),
                "disabled")
        }

        @Test
        fun `when asking for the guest after the link is revoked then the answer changes after at most 30 seconds`() = runTest {
            val created = create(audience = ShareAudience.GUESTS)
            val first = service.guestCaller(created.link.id)
            service.revokeLink(asUser(OWNER), created.link.id)

            val cached = service.guestCaller(created.link.id)

            assertNull(cached, "revocation clears the cache of this replica at once")
            assertEquals(created.link.id, first?.shareId, "before: a guest")
        }

        @Test
        fun `when the link is revoked behind the cache then the guest is gone after 30 seconds`() = runTest {
            val created = create(audience = ShareAudience.GUESTS)
            assertEquals(created.link.id, service.guestCaller(created.link.id)?.shareId, "valid, now cached")
            links.revoke(created.link.id, clock.now())

            assertEquals(created.link.id, service.guestCaller(created.link.id)?.shareId, "inside the cache window")
            clock.advanceBy(31.seconds)

            assertNull(service.guestCaller(created.link.id), "after the window")
        }

        @Test
        fun `when refreshing with the token of another link or a revoked one then NOT_FOUND`() = runTest {
            val one = create(audience = ShareAudience.GUESTS)
            val two = create(audience = ShareAudience.GUESTS)

            assertIs<ExchangeOutcome.Guest>(service.checkRefresh(one.link.id, one.token, "198.51.100.7"), "own token")
            assertEquals(ExchangeOutcome.Failed(ExchangeFailure.NOT_FOUND), service.checkRefresh(one.link.id, two.token,
                "198.51.100.7"), "foreign token")
            service.revokeLink(asUser(OWNER), one.link.id)
            assertEquals(ExchangeOutcome.Failed(ExchangeFailure.NOT_FOUND), service.checkRefresh(one.link.id, one.token,
                "198.51.100.7"), "revoked")
        }
    }

    @Nested
    inner class RateLimits {

        private fun failures(reason: ExchangeFailure) =
            audit.events.count { it.eventType == "library.share.exchange-failed" && reason.name in it.details.toString() }

        @Test
        fun `when one address exchanges a VALID token 31 times in a minute then the 31st is RATE_LIMITED, another address is not`() =
            runTest {
            val created = create()

            val outcomes = (1..31).map { open(created.token) }
            val other = open(created.token, ip = "203.0.113.9")

            assertTrue(outcomes.take(30).all { it is ExchangeOutcome.SignedIn }, "30 are fine")
            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(outcomes.last(), "31st").reason,
                "a valid token is no free pass")
            assertIs<ExchangeOutcome.SignedIn>(other, "another address")
        }

        @Test
        fun `when IPv6 addresses of one 64 bit prefix attempt 31 times then they count together`() = runTest {
            val created = create()

            val outcomes = (1..31).map { open(created.token, ip = "2001:db8:1:2:0:0:0:$it") }

            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(outcomes.last(), "31st").reason,
                "one /64 is one client")
        }

        @Test
        fun `when a guest refreshes 31 times in a minute then the 31st is RATE_LIMITED`() = runTest {
            val created = create(audience = ShareAudience.GUESTS)

            val outcomes = (1..31).map { service.checkRefresh(created.link.id, created.token, "198.51.100.7") }

            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(outcomes.last(), "31st").reason,
                "refresh is limited too")
        }

        @Test
        fun `when the CORRECT password is verified 11 times in a minute then the 11th is RATE_LIMITED`() = runTest {
            val created = create(password = "right-password")

            val outcomes = (1..11).map { open(created.token, "right-password") }

            assertTrue(outcomes.take(10).all { it is ExchangeOutcome.SignedIn }, "ten verifications")
            assertEquals(ExchangeFailure.RATE_LIMITED, assertIs<ExchangeOutcome.Failed>(outcomes.last(), "11th").reason,
                "even a correct one")
        }

        @Test
        fun `when an address is blocked for 40 attempts then the audit trail gets one rate limit event, the metric counts all`() =
            runTest {
            val created = create()
            repeat(30) { open(created.token) }
            audit.events.size.let { before ->
                repeat(40) { open(created.token) }

                assertEquals(1, failures(ExchangeFailure.RATE_LIMITED), "one event per block window and key")
                assertEquals(before + 1, audit.events.size, "nothing else was written")
            }
            assertEquals(40, metrics.exchanges.count { it == "rate_limited" }, "the metric counts every blocked attempt")
        }

        @Test
        fun `when real failures happen then each one is audited, also next to rate limit events`() = runTest {
            repeat(3) { open(unknownToken(it)) }

            assertEquals(3, failures(ExchangeFailure.NOT_FOUND), "unknown tokens are audited every time")
        }

        private fun unknownToken(n: Int) = "unknown-token-$n"
    }
}
