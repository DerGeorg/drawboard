package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCancelled
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCreated
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionFinished
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionStarted
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.provides.AdvanceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.GetSessionQuery
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionAnswer
import at.dergeorg.drawboard.planning.domain.sessions.provides.SessionOperation
import at.dergeorg.drawboard.planning.domain.sessions.provides.StartCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class EstimationServiceTest {

    private val world = EstimationWorld()

    private fun assertCode(code: ErrorCode, failure: DomainException, message: String) = assertEquals(code, failure.errorCode, message)

    @Nested
    inner class Creating {

        @Test
        fun `when a session is created then it waits in the lobby, anonymous by default, cards in order, audited`() = runTest {
            val session = world.create(mode = EstimationMode.MAGIC, items = 3)

            assertEquals(SessionState.LOBBY to "Sprint 42", session.state to session.title, "lobby, trimmed title")
            assertTrue(session.anonymous, "anonymous unless said otherwise (E5)")
            assertEquals(
                SessionSettings(placingSeconds = 60, movingSeconds = 120, markThreshold = 3),
                session.settings,
                "defaults filled in",
            )
            assertEquals(listOf(0, 1, 2), session.items.map { it.position }, "positions")
            assertTrue(session.me.moderator, "the creator moderates")
            val details = assertIs<SessionCreated>(world.audit.events.single().details, "audit")
            assertEquals(Triple("MAGIC", 3, "FIBONACCI"), Triple(details.mode, details.items, details.deck), "counts only")
            assertEquals(listOf("created/magic"), world.metrics.sessions, "metric")
        }

        @Test
        fun `when settings and cards are wrong then every violation comes back at once`() = runTest {
            val failure = assertFailsWith<ValidationFailedException>("refused") {
                world.create(mode = EstimationMode.ROTATION, items = 0, settings = SessionSettings(placingSeconds = 60))
            }

            assertEquals(
                setOf("items", "settings.rounds", "settings.roundSeconds", "settings.placingSeconds"),
                failure.invalidFields.map { it.field }.toSet(),
                "all of them",
            )
        }

        @Test
        fun `when a board has three active sessions then a fourth is refused until one is idle for a day (E16, E22)`() = runTest {
            repeat(3) { world.create() }

            val full = assertFailsWith<DomainException>("fourth") { world.create() }
            world.clock.advanceBy(24.hours)
            val fourth = world.create()

            assertCode(ErrorCode.PLANNING_SESSION_LIMIT_REACHED, full, "limit")
            assertEquals("3", full.params["limit"], "the limit is named")
            assertEquals(SessionState.LOBBY, fourth.state, "the idle ones were cancelled first")
            assertEquals(3, world.sessions.rows.values.count { it.state == SessionState.CANCELLED }, "three idle cancels")
            assertTrue(world.audit.events.any { (it.details as? SessionCancelled)?.idle == true }, "audited as idle")
        }

        @Test
        fun `when a board has more closed sessions than kept then the oldest cancelled go first`() = runTest {
            val small = EstimationWorld(EstimationLimits(maxClosedSessions = 1))
            val first = small.create()
            small.service.cancel(small.board, first.id, small.moderatorView)
            small.clock.advanceBy(1.seconds)
            val second = small.create()
            small.service.cancel(small.board, second.id, small.moderatorView)

            small.create()

            assertNull(small.sessions.rows[first.id], "the oldest cancelled one is gone")
            assertEquals(SessionState.CANCELLED, small.sessions.rows[second.id]?.state, "the newer one stays")
            assertTrue(small.items.rows.values.none { it.sessionId == first.id }, "with its cards")
        }

        @Test
        fun `when a user creates eleven sessions in a minute then the eleventh is 429 and counted as a refusal`() = runTest {
            val lots = EstimationWorld(EstimationLimits(maxActiveSessions = 50))
            repeat(10) { lots.create() }

            assertFailsWith<RateLimitedException>("eleventh") { lots.create() }
            assertEquals(listOf("rate_limit"), lots.metrics.refused, "metric")
        }
    }

    @Nested
    inner class Lobby {

        @Test
        fun `when callers join then each gets a random seat id and the version rises - joining again changes nothing`() = runTest {
            val session = world.create()

            world.service.join(world.board, session.id, world.anna)
            val afterOne = world.stored(session).version
            world.service.join(world.board, session.id, world.anna)

            val seat = world.seatOf(session, world.anna)
            assertTrue(seat.id != world.anna.id && seat.seated, "a session-local id, taking part")
            assertEquals(session.version + 1, afterOne, "one join, one version")
            assertEquals(afterOne, world.stored(session).version, "the second join is a no-op")
        }

        @Test
        fun `when a caller leaves then the seat is gone - without a seat leaving changes nothing`() = runTest {
            val session = world.create()
            world.service.join(world.board, session.id, world.anna)

            world.service.leave(world.board, session.id, world.anna)
            world.service.leave(world.board, session.id, world.ben)

            assertTrue(world.seats.rows.values.none { it.sessionId == session.id }, "no seats")
        }

        @Test
        fun `when the seats are taken then 409 PLANNING_SESSION_FULL names the cap - per link, guests, total (E10)`() = runTest {
            val tight = EstimationWorld(EstimationLimits(maxSeats = 3, maxGuests = 2, maxGuestsPerShare = 1))
            val session = tight.create()
            tight.service.join(tight.board, session.id, tight.guest("G1"))

            val perShare = assertFailsWith<DomainException>("same link") { tight.service.join(tight.board, session.id, tight.guest("G2")) }
            tight.service.join(tight.board, session.id, tight.guest("G3", shareId = Uuid.generateV7()))
            val guests = assertFailsWith<DomainException>("guests") {
                tight.service.join(tight.board, session.id, tight.guest("G4", shareId = Uuid.generateV7()))
            }
            tight.service.join(tight.board, session.id, tight.anna)
            val total = assertFailsWith<DomainException>("total") { tight.service.join(tight.board, session.id, tight.ben) }

            assertEquals(listOf("1", "2", "3"), listOf(perShare, guests, total).map { it.params["limit"] }, "the cap that was hit")
            assertCode(ErrorCode.PLANNING_SESSION_FULL, total, "full")
            assertEquals(listOf("session_full", "session_full", "session_full"), tight.metrics.refused, "metrics")
        }

        @Test
        fun `when the session has started then join and leave are 409 PLANNING_SESSION_WRONG_STATE`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)

            val join = assertFailsWith<DomainException>("join") { world.service.join(world.board, session.id, world.cleo) }
            val leave = assertFailsWith<DomainException>("leave") { world.service.leave(world.board, session.id, world.anna) }

            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, join, "join")
            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, leave, "leave")
            assertEquals("ROTATING", join.params["state"], "the current state is named")
        }

        @Test
        fun `when a guest without a seat touches a reviewed session then every operation is 404 with the session id only (E9)`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 0))
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 1))
            val gus = world.guest()

            val failures = listOf(
                assertFailsWith<DomainException>("header") {
                    world.service.header(world.board, session.id, gus, SessionOperation.JOIN_OR_LEAVE, session.items[0].id)
                },
                assertFailsWith<DomainException>("get") {
                    world.service.get(GetSessionQuery(world.board, session.id, world.viewer(gus)) { false })
                },
                assertFailsWith<DomainException>("join") { world.service.join(world.board, session.id, gus) },
                assertFailsWith<DomainException>("leave") { world.service.leave(world.board, session.id, gus) },
            )

            failures.forEach {
                assertCode(ErrorCode.PLANNING_SESSION_NOT_FOUND, it, "404")
                assertEquals(mapOf("sessionId" to session.id.toString()), it.params, "no item id, nothing else")
            }
            assertTrue(world.service.list(world.board, SessionState.ACTIVE, world.viewer(gus)).isEmpty(), "not listed either")
        }
    }

    @Nested
    inner class Starting {

        @Test
        fun `when the moderator starts then the picked seats get the slots 0 to P-1, the others watch, and it is audited`() = runTest {
            val session = world.create(items = 4)
            listOf(world.anna, world.ben, world.guest(), world.cleo).forEach { world.service.join(world.board, session.id, it) }
            val picked = world.seats.findBySession(session.id).take(3).map { it.id }.toSet()

            val started = world.service.start(StartCommand(world.board, session.id, world.moderatorView, picked))

            assertEquals(SessionState.ROTATING to 0, started.state to started.round, "round 0")
            assertEquals(setOf(0, 1, 2), world.seats.findBySession(session.id).mapNotNull { it.slot }.toSet(), "three slots")
            assertEquals(listOf(true, true, true, false), started.seats.map { it.seated }, "Cleo watches")
            val details = assertIs<SessionStarted>(world.audit.events.last().details, "audit")
            assertEquals(2 to 1, details.memberSeats to details.guestSeats, "members and guests apart")
        }

        @Test
        fun `when sessions are started many times then the slots do not follow the order of joining (E2)`() = runTest {
            val orders = (1..20).map {
                val fresh = EstimationWorld()
                val session = fresh.started(fresh.create(items = 3), fresh.anna, fresh.ben, fresh.cleo)
                fresh.seats.findBySession(session.id).map { it.slot }
            }.toSet()

            assertTrue(orders.size > 1, "SecureRandom: not always the same slots, was $orders")
        }

        @Test
        fun `when more seats than cards are picked then 400 seatIds in both modes (C3)`() = runTest {
            listOf(EstimationMode.MAGIC, EstimationMode.ROTATION).forEach { mode ->
                val session = world.create(
                    mode = mode,
                    items = 2,
                    settings = if (mode == EstimationMode.MAGIC) world.magicSettings else world.rotationSettings(1),
                )
                listOf(world.anna, world.ben, world.cleo).forEach { world.service.join(world.board, session.id, it) }
                val all = world.seats.findBySession(session.id).map { it.id }.toSet()

                val failure = assertFailsWith<ValidationFailedException>("$mode") {
                    world.service.start(StartCommand(world.board, session.id, world.moderatorView, all))
                }

                assertEquals(listOf("seatIds"), failure.invalidFields.map { it.field }, "$mode: field")
            }
        }

        @Test
        fun `when fewer than two seats remain, an id is unknown or there are more rounds than seats then 400 seatIds`() = runTest {
            val session = world.create(items = 4, settings = world.rotationSettings(rounds = 3))
            listOf(world.anna, world.ben).forEach { world.service.join(world.board, session.id, it) }
            val seats = world.seats.findBySession(session.id).map { it.id }

            listOf(setOf(seats[0]), setOf(seats[0], Uuid.random()), seats.toSet()).forEach { ids ->
                assertFailsWith<ValidationFailedException>("$ids") {
                    world.service.start(StartCommand(world.board, session.id, world.moderatorView, ids))
                }
            }
        }

        @Test
        fun `when a session is no longer in the lobby then start is 409 before the seats are even looked at`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)

            val failure = assertFailsWith<DomainException>("again") {
                world.service.start(StartCommand(world.board, session.id, world.moderatorView, setOf(Uuid.random())))
            }

            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, failure, "state before the 400 of the body")
        }

        @Test
        fun `when a seat's link was revoked before the start then it is dropped first (E11)`() = runTest {
            val session = world.create()
            val gus = world.guest()
            listOf(world.anna, world.ben, gus).forEach { world.service.join(world.board, session.id, it) }
            world.shares.revoked += world.share

            val started = world.service.start(
                StartCommand(world.board, session.id, world.moderatorView, world.seats.findBySession(session.id).map { it.id }.toSet()),
            )

            assertEquals(listOf("Anna", "Ben"), started.seats.map { it.displayName }, "the guest is gone")
        }
    }

    @Nested
    inner class Clock {

        @Test
        fun `when a deadline passed then the next get applies it before comparing the ETag - a 304 never hides it`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)
            world.clock.advanceBy(60.seconds)

            val answer = world.service.get(GetSessionQuery(world.board, session.id, world.viewer(world.anna)) { it == session.version })

            val found = assertIs<SessionAnswer.Found>(answer, "the old ETag is stale")
            assertEquals(1 to session.version + 1, found.session.round to found.version, "round 1, one version on")
        }

        @Test
        fun `when nothing changed then get answers 304 with the version`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)

            val answer = world.service.get(GetSessionQuery(world.board, session.id, world.viewer(world.anna)) { it == session.version })

            assertEquals(session.version, assertIs<SessionAnswer.NotModified>(answer, "304").version, "same version")
        }

        @Test
        fun `when thirty clients poll at the deadline then there is one transition (E15)`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)
            world.clock.advanceBy(60.seconds)

            val versions = (1..30).map {
                async { world.service.get(GetSessionQuery(world.board, session.id, world.viewer(world.anna)) { false }).version }
            }.awaitAll()

            assertEquals(setOf(session.version + 1), versions.toSet(), "everybody sees the same single step")
        }

        @Test
        fun `when the moderator advances with the current state and round then the next round starts, a stale one is 409`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)

            val next = world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 0))
            val stale = assertFailsWith<DomainException>("double click") {
                world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 0))
            }

            assertEquals(1, next.round, "round 1")
            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, stale, "never skips a round (E14)")
            assertEquals("1", stale.params["round"], "the current round is named")
        }

        @Test
        fun `when the lobby has been idle for a day then get finds it cancelled`() = runTest {
            val session = world.create()
            world.clock.advanceBy(24.hours)

            assertEquals(SessionState.CANCELLED, world.look(session, world.moderatorView).state, "idle cancel")
            assertEquals(listOf("created/rotation", "idle_cancelled/rotation"), world.metrics.sessions, "metric")
        }

        @Test
        fun `when advancing from the lobby or REVIEW then 409, there is nothing to advance`() = runTest {
            val session = world.create()

            val failure = assertFailsWith<DomainException>("lobby") {
                world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.LOBBY, 0))
            }

            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, failure, "lobby")
        }
    }

    @Nested
    inner class Ending {

        private suspend fun inReview(mode: EstimationMode = EstimationMode.ROTATION, anonymous: Boolean? = null) =
            world.started(world.create(mode = mode, anonymous = anonymous), world.anna, world.ben).also {
                world.clock.advanceBy(1.hours)
                world.look(it, world.moderatorView)
            }

        @Test
        fun `when the moderator finishes a review then it is DONE, audited with counts, and cannot be cancelled any more`() = runTest {
            val session = inReview()

            val done = world.service.finish(world.board, session.id, world.moderatorView)
            val cancel = assertFailsWith<DomainException>("cancel") { world.service.cancel(world.board, session.id, world.moderatorView) }

            assertEquals(SessionState.DONE, done.state, "done")
            assertTrue(done.closedAt != null, "closed")
            assertEquals(0 to 0, assertIs<SessionFinished>(world.audit.events.last().details, "audit")
                .let { it.decisions to it.overridden }, "counts")
            assertCode(ErrorCode.PLANNING_SESSION_WRONG_STATE, cancel, "final")
        }

        @Test
        fun `when a running session is finished then 409 - only a review can be finished`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)

            assertCode(
                ErrorCode.PLANNING_SESSION_WRONG_STATE,
                assertFailsWith<DomainException>("running") { world.service.finish(world.board, session.id, world.moderatorView) },
                "running",
            )
        }

        @Test
        fun `when a session is cancelled then its entries, moves and columns are deleted at once (E22)`() = runTest {
            val session = world.started(world.create(mode = EstimationMode.MAGIC), world.anna, world.ben)
            val stored = world.stored(session)
            val item = world.items.findBySession(session.id).first()
            world.items.updateAll(listOf(item.copy(column = "5")))
            world.moves.insert(StoredMove(Uuid.random(), stored.id, item.id, null, "3", "5", world.clock.now(), 1))
            world.entries.insert(StoredEntry(Uuid.generateV7(), stored.id, item.id, null, 0, "5", "x", false, 1, world.clock.now()))

            val cancelled = world.service.cancel(world.board, session.id, world.moderatorView)

            assertEquals(SessionState.CANCELLED, cancelled.state, "cancelled")
            assertTrue(world.moves.rows.isEmpty() && world.entries.rows.isEmpty(), "nothing entered is left")
            assertTrue(world.items.findBySession(session.id).all { it.column == null }, "no placement either")
            assertEquals(false, (world.audit.events.last().details as SessionCancelled).idle, "by the moderator")
        }

        @Test
        fun `when an anonymous session enters REVIEW then entries lose their seats and seats their slots (E5)`() = runTest {
            val session = world.started(world.create(), world.anna, world.ben)
            val item = world.items.findBySession(session.id).first()
            world.entries.insert(
                StoredEntry(Uuid.generateV7(), session.id, item.id, world.seatOf(
                    session,
                    world.anna,
                ).id, 0, "5", null, false, 1, world.clock.now()),
            )

            world.clock.advanceBy(1.hours)
            world.look(session, world.moderatorView)

            assertTrue(world.entries.rows.values.all { it.seatId == null }, "no seat on any entry")
            assertTrue(world.seats.findBySession(session.id).all { it.slot == null }, "no slots")
        }

        @Test
        fun `when a named rotation enters REVIEW then entries keep their seats, magic always drops the movers`() = runTest {
            val named = world.started(world.create(anonymous = false), world.anna, world.ben)
            val item = world.items.findBySession(named.id).first()
            val annaSeat = world.seatOf(named, world.anna)
            world.entries.insert(StoredEntry(Uuid.generateV7(), named.id, item.id, annaSeat.id, 0, "5", null, false, 1, world.clock.now()))
            val magic = world.started(world.create(mode = EstimationMode.MAGIC, anonymous = false), world.anna, world.ben)
            val card = world.items.findBySession(magic.id).first()
            val annaInMagic = world.seatOf(magic, world.anna).id
            world.moves.insert(StoredMove(Uuid.random(), magic.id, card.id, annaInMagic, "3", "5", world.clock.now(), 1))

            world.clock.advanceBy(1.hours)
            world.look(named, world.moderatorView)
            world.look(magic, world.moderatorView)

            assertEquals(annaSeat.id, world.entries.rows.values.single().seatId, "named: the mapping stays until the purge")
            assertNull(world.moves.rows.values.single().seatId, "the mover is never kept (E4)")
        }
    }

    @Nested
    inner class Revocation {

        @Test
        fun `when a link is revoked in the lobby then its seats are deleted and the version rises`() = runTest {
            val session = world.create()
            world.service.join(world.board, session.id, world.guest())
            val before = world.stored(session).version

            world.service.removeGuestsOfShare(world.share)

            assertTrue(world.seats.rows.isEmpty(), "gone")
            assertEquals(before + 1, world.stored(session).version, "version")
        }

        @Test
        fun `when a link is revoked in a running rotation then the seat is removed, entries go, cards are touched (E11)`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(items = 3), world.anna, gus)
            val held = world.mine(session, gus).first()
            world.entries.insert(
                StoredEntry(Uuid.generateV7(), session.id, held.id, world.seatOf(
                    session,
                    gus,
                ).id, 0, "8", null, false, 1, world.clock.now()),
            )

            world.service.removeGuestsOfShare(world.share)

            assertTrue(world.seatOf(session, gus).removed, "removed, not deleted")
            assertTrue(world.entries.rows.isEmpty(), "its entries are gone")
            assertTrue(world.items.rows.getValue(held.id).touched, "the card is touched")
            assertEquals(listOf("Anna"), world.look(session, world.moderatorView).seats.map { it.displayName }, "not listed")
        }

        @Test
        fun `when a link is revoked while magic is placing then the guest's columns are cleared and marked in MOVING`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(mode = EstimationMode.MAGIC, items = 2), world.anna, gus)
            val dealt = world.mine(session, gus).single()
            world.items.updateAll(listOf(dealt.copy(column = "5")))

            world.service.removeGuestsOfShare(world.share)
            world.clock.advanceBy(60.seconds)
            val moving = world.look(session, world.moderatorView)

            assertNull(world.items.rows.getValue(dealt.id).column, "cleared")
            assertEquals(true, moving.items.single { it.id == dealt.id }.marked, "marked for the review")
        }

        @Test
        fun `when a link is revoked while magic is moving then its placements and moves go, the rest is chained again (B2)`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(mode = EstimationMode.MAGIC, items = 2), world.anna, gus)
            val annaCard = world.mine(session, world.anna).single().copy(column = "3")
            val gusCard = world.mine(session, gus).single().copy(column = "5")
            world.items.updateAll(listOf(annaCard, gusCard))
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.PLACING, 0))
            val gusSeat = world.seatOf(session, gus).id
            val annaSeat = world.seatOf(session, world.anna).id
            val now = world.clock.now()
            // Anna's card: 3 -(Gus)-> 8 -(Anna)-> 13; Gus's own card: 5 -(Anna)-> 21
            world.moves.insert(StoredMove(Uuid.random(), session.id, annaCard.id, gusSeat, "3", "8", now, 1))
            world.moves.insert(StoredMove(Uuid.random(), session.id, annaCard.id, annaSeat, "8", "13", now, 2))
            world.moves.insert(StoredMove(Uuid.random(), session.id, gusCard.id, annaSeat, "5", "21", now, 3))
            world.items.updateAll(
                listOf(annaCard.copy(column = "13", moveCount = 2), gusCard.copy(column = "21", moveCount = 1)),
            )

            world.service.removeGuestsOfShare(world.share)
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.MOVING, 0))
            val review = world.look(session, world.moderatorView)

            val anna = world.items.rows.getValue(annaCard.id)
            assertEquals(Triple("13", 1, true), Triple(anna.column, anna.moveCount, anna.marked), "Anna's move stays, marked")
            assertEquals(listOf("3", "13"), review.items.single { it.id == annaCard.id }.result?.moveTrail,
                "chained from Anna's placement: no column only Gus chose")
            assertEquals(listOf("21"), review.items.single { it.id == gusCard.id }.result?.moveTrail,
                "Gus's placement is gone, the move now starts from no column")
            assertEquals(2, world.moves.rows.size, "Gus's move is deleted")
        }

        @Test
        fun `when a running session is cancelled then no slot and no mark of a removed seat is kept`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(mode = EstimationMode.MAGIC, items = 3), world.anna, gus)
            world.service.removeGuestsOfShare(world.share)
            assertTrue(world.items.findBySession(session.id).any { it.touched }, "the guest's cards were touched")

            world.service.cancel(world.board, session.id, world.moderatorView)

            assertTrue(world.seats.findBySession(session.id).all { it.slot == null }, "no slots")
            assertTrue(world.items.findBySession(session.id).none { it.touched }, "no touched card")
        }

        @Test
        fun `when a link is revoked in REVIEW then the record stands`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(), world.anna, gus)
            world.clock.advanceBy(1.hours)
            world.look(session, world.moderatorView)
            val before = world.stored(session).version

            world.service.removeGuestsOfShare(world.share)

            assertTrue(!world.seatOf(session, gus).removed, "not removed")
            assertEquals(before, world.stored(session).version, "nothing changed")
        }

        @Test
        fun `when removeGuestsOfShare never ran then entering REVIEW drops the seats of revoked links anyway (safety net)`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(), world.anna, gus)
            val held = world.mine(session, gus).first()
            world.entries.insert(
                StoredEntry(Uuid.generateV7(), session.id, held.id, world.seatOf(
                    session,
                    gus,
                ).id, 0, "8", null, false, 1, world.clock.now()),
            )
            world.shares.revoked += world.share

            world.clock.advanceBy(1.hours)
            val review = world.look(session, world.moderatorView)

            assertEquals(listOf("Anna"), review.seats.map { it.displayName }, "dropped")
            assertTrue(world.entries.rows.isEmpty(), "its entry is not part of the result")
        }
    }

    @Nested
    inner class Retention {

        @Test
        fun `when a session has been DONE for 30 days then the purge drops reasons, seats and moves - younger ones stay (E22)`() = runTest {
            val named = world.started(world.create(anonymous = false), world.anna, world.ben)
            val item = world.items.findBySession(named.id).first()
            world.entries.insert(
                StoredEntry(Uuid.generateV7(), named.id, item.id, world.seatOf(
                    named,
                    world.anna,
                ).id, 1, "8", "why", false, 1, world.clock.now()),
            )
            world.clock.advanceBy(1.hours)
            world.look(named, world.moderatorView)
            world.service.finish(world.board, named.id, world.moderatorView)

            world.clock.advanceBy(29.days)
            val early = world.service.reduceExpired(world.clock.now())
            world.clock.advanceBy(1.days + 1.seconds)
            val late = world.service.reduceExpired(world.clock.now())

            assertEquals(0 to 1, early to late, "only after 30 days")
            val entry = world.entries.rows.values.single()
            assertEquals(Triple(null, null, "8"), Triple(entry.seatId, entry.reason, entry.value), "reduced to the value")
            assertTrue(world.stored(named).reducedAt != null, "marked as reduced")
            assertEquals(0, world.look(named, world.moderatorView).items.first().result?.entries?.size, "no entry in the answer")
        }

        @Test
        fun `when boards are purged for good then their sessions go with everything in them, other boards stay`() = runTest {
            val gone = world.started(world.create(), world.anna, world.ben)
            val other = Uuid.generateV7()
            val kept = world.create(on = other)

            world.service.deleteBoardData(listOf(world.board))

            assertEquals(setOf(kept.id), world.sessions.rows.keys, "only the other board's session")
            assertTrue(world.seats.rows.values.none { it.sessionId == gone.id } && world.items.rows.values.none { it.sessionId == gone.id },
                "seats and cards too")
        }
    }

    @Nested
    inner class Listing {

        @Test
        fun `when sessions are listed then they come as summaries, active or closed, newest first`() = runTest {
            val first = world.create()
            world.clock.advanceBy(1.seconds)
            val second = world.create(mode = EstimationMode.MAGIC)
            world.service.join(world.board, second.id, world.anna)
            world.service.cancel(world.board, first.id, world.moderatorView)

            val active = world.service.list(world.board, SessionState.ACTIVE, world.viewer(world.anna))
            val closed = world.service.list(world.board, SessionState.CLOSED, world.viewer(world.anna))

            assertEquals(listOf(second.id), active.map { it.id }, "active")
            assertEquals(1 to 4, active.single().seatCount to active.single().itemCount, "counts")
            assertTrue(active.single().me.seated, "Anna's own seat")
            assertEquals(listOf(first.id), closed.map { it.id }, "closed")
        }

        @Test
        fun `when guests of one link poll a lot then the limit is also keyed by share - no session is over its own (E17)`() = runTest {
            val tight = EstimationWorld(EstimationLimits(getsPerMinute = 4, shareGetsPerMinute = 6))
            val session = tight.create()
            val first = tight.viewer(tight.guest("G1"))
            val second = tight.viewer(tight.guest("G2"))
            repeat(4) { tight.service.get(GetSessionQuery(tight.board, session.id, first) { false }) }
            repeat(2) { tight.service.get(GetSessionQuery(tight.board, session.id, second) { false }) }

            assertFailsWith<RateLimitedException>("the seventh call of the link") {
                tight.service.get(GetSessionQuery(tight.board, session.id, second) { false })
            }
            assertFailsWith<RateLimitedException>("the fifth call of the first session") {
                tight.service.get(GetSessionQuery(tight.board, session.id, first) { false })
            }
            tight.service.get(GetSessionQuery(tight.board, session.id, tight.moderatorView) { false }) // a member has their own
        }

        @Test
        fun `when a guest lists then a REVIEW session shows only with its own seat`() = runTest {
            val gus = world.guest()
            val withGus = world.started(world.create(), world.anna, gus)
            val without = world.started(world.create(), world.anna, world.ben)
            world.clock.advanceBy(1.hours)

            val listed = world.service.list(world.board, SessionState.ACTIVE, world.viewer(gus))

            assertEquals(listOf(withGus.id), listed.map { it.id }, "only the one with a seat, ${without.id} is hidden")
        }
    }
}
