package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.EstimationItemRef
import at.dergeorg.drawboard.contract.model.EstimationItemRefKind
import at.dergeorg.drawboard.contract.model.EstimationMode
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionState
import at.dergeorg.drawboard.contract.model.EstimationSettings
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.NewEstimationItem
import at.dergeorg.drawboard.integration.CapturedSpans
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.GuestIntegrationTest
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.planning.domain.sessions.model.DecisionOverridden
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCreated
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionFinished
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionStarted
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Import
import org.awaitility.Awaitility.await
import kotlin.time.Duration.Companion.seconds
import kotlin.time.toJavaDuration
import java.util.Base64
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.r2dbc.core.DatabaseClient
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Estimation sessions end to end (3.15, Fable E1-E24, contract review C1-C3, contract 3.0.0): both modes from the lobby to DONE, what
 * each caller sees in each state (E2-E5, E9), the order of refusals (C2), more seats than cards (C3), the polls with ETag/304, guests
 * and the revocation of their link, the rates, the trash. Really signed tokens and a real port; guests are switched on. The caps are
 * lowered (6 seats, 3 guests, 2 per link, 2 closed sessions per board) so a cap is reached with a few requests; the rates are the real
 * ones (E17). Time-driven behaviour (deadlines, idle, retention) is [EstimationClockIntegrationTest].
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "management.otlp.metrics.export.enabled=false",
        "planning.estimation.max-seats=6",
        "planning.estimation.max-guests=3",
        "planning.estimation.max-guests-per-share=2",
        "planning.estimation.max-closed-sessions=2",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(CapturedSpans::class)
class EstimationIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val database: DatabaseClient,
    private val auditLog: AuditLog,
    private val spans: CapturedSpans,
) {

    private val read = EstimationJson(json)

    private fun user(name: String) = SharingUser(client, port, name)

    private fun SharingUser.act() = actor(json)

    /** A board with one user of each role; Edna (EDITOR) moderates, Anna, Ben and Cleo comment and take part. */
    inner class Team {
        val owner = user("Olga")
        val editor = user("Edna")
        val anna = user("Anna")
        val ben = user("Ben")
        val cleo = user("Cleo")
        val viewer = user("Vic")
        val board = owner.createBoard("Sprint").also { board ->
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)
            listOf(anna, ben, cleo).forEach { owner.grantUser("boards", board.id, it, GrantRole.COMMENTER) }
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)
        }
        val ownerApi = owner.act()
        val moderator = editor.act()
        val annaApi = anna.act()
        val benApi = ben.act()
        val cleoApi = cleo.act()
        val viewerApi = viewer.act()

        fun open(request: at.dergeorg.drawboard.contract.model.NewEstimationSession = newSession()) =
            moderator.openSession(read, board.id, request)

        /** Everybody in [who] joins, the moderator starts with all of them. */
        fun started(session: EstimationSession, vararg who: Actor): EstimationSession {
            who.forEach { assertEquals(HttpStatus.NO_CONTENT, it.joinSession(board.id, session.id).status, "join") }
            val reply = moderator.startSession(board.id, session.id, seats(session))
            assertEquals(HttpStatus.OK, reply.status, "start, body ${reply.body}")
            return read.session(reply)
        }

        fun seats(session: EstimationSession): Set<Uuid> = moderator.lookAt(read, board.id, session.id).seats.map { it.id }.toSet()

        fun look(who: Actor, session: EstimationSession) = who.lookAt(read, board.id, session.id)

        /** The cards [who] works on now, as the server tells them (`mine`). */
        fun mine(who: Actor, session: EstimationSession) = look(who, session).items.filter { it.mine }

        fun notMine(who: Actor, session: EstimationSession) = look(who, session).items.filter { !it.mine }
    }

    private fun Reply.assertNoStore(message: String) {
        assertEquals("no-store", headers.cacheControl, "$message: Cache-Control")
        assertTrue(headers.vary.contains(HttpHeaders.AUTHORIZATION), "$message: Vary Authorization")
    }

    @Nested
    inner class Creating {

        @Test
        fun `when the moderator creates a session then 201 with Location, LOBBY, anonymous by default, no-store, audited`() = runBlocking {
            val team = Team()

            val reply = team.moderator.createSession(
                team.board.id,
                newSession(title = "  Sprint 42\u00a0", settings = EstimationSettings(rounds = 2, roundSeconds = 60)),
            )

            assertEquals(HttpStatus.CREATED, reply.status, "created, body ${reply.body}")
            val session = read.session(reply)
            assertEquals("/api/boards/${team.board.id}/estimation-sessions/${session.id}", reply.headers.location?.path, "Location")
            assertEquals(EstimationSessionState.LOBBY to "Sprint 42", session.state to session.title, "lobby, trimmed")
            assertTrue(session.anonymous && session.me.moderator, "anonymous by default, the creator moderates")
            assertEquals(true, session.settings.advanceWhenDone, "the default of the mode is filled in")
            reply.assertNoStore("create")
            val details = checkNotNull(auditLog.history("session", session.id.toString()).single().detailsAs<SessionCreated>())
            assertEquals(Triple("ROTATION", 4, "FIBONACCI"), Triple(details.mode, details.items, details.deck), "counts, no title")
        }

        @Test
        fun `when a commenter or a viewer creates then 403, a stranger 404`() {
            val team = Team()

            team.annaApi.createSession(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "commenter")
            team.viewerApi.createSession(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "viewer")
            user("Sam").act().createSession(team.board.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "stranger")
        }

        @Test
        fun `when a title is two lines, has a format character, a line separator or only no-break spaces then 400 (E12, C1)`() {
            val team = Team()

            listOf("two\nlines", "zero​width", "line separator", "  ").forEach { title ->
                team.moderator.createSession(team.board.id, newSession(title = title))
                    .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, "title ${title.length}")
            }
        }

        @Test
        fun `when a title of 250000 blanks is sent then it is refused quickly - the pattern is linear (C1)`() {
            val team = Team()
            val started = System.nanoTime()

            val reply = team.moderator.createSession(team.board.id, newSession(title = " ".repeat(250_000) + "x" + " ".repeat(10)))

            assertEquals(HttpStatus.BAD_REQUEST, reply.status, "too long")
            assertTrue(System.nanoTime() - started < 10_000_000_000L, "no backtracking: well under 10 s")
        }

        @Test
        fun `when settings of the other mode, a duplicate card or a kanban card without card id are sent then 400 per field`() {
            val team = Team()
            val block = Uuid.random().toString()
            val twice = listOf(
                NewEstimationItem(EstimationItemRef(EstimationItemRefKind.STORY, block), "A"),
                NewEstimationItem(EstimationItemRef(EstimationItemRefKind.STORY, block), "B"),
                NewEstimationItem(EstimationItemRef(EstimationItemRefKind.KANBAN_CARD, block), "C"),
            )

            val settings = team.moderator.createSession(team.board.id, newSession(EstimationMode.MAGIC, settings = rotationSettings()))
            val cards = team.moderator.createSession(team.board.id, newSession(items = twice))

            settings.assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, "settings")
            assertTrue(
                settings.error().violations.orEmpty().map { it.field }.containsAll(listOf("settings.placingSeconds", "settings.rounds")),
                "a violation per field, ${settings.body}",
            )
            assertEquals(setOf("items[1].ref", "items[2].ref.cardId"), cards.error().violations.orEmpty().map { it.field }.toSet(), "cards")
        }

        @Test
        fun `when a board has three active sessions then the fourth is 409 PLANNING_SESSION_LIMIT_REACHED`() {
            val team = Team()
            repeat(3) { team.open() }

            val fourth = team.moderator.createSession(team.board.id)

            fourth.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_LIMIT_REACHED, "fourth")
            assertEquals("3", fourth.error().params?.get("limit"), "limit")
        }
    }

    @Nested
    inner class Lobby {

        @Test
        fun `when members join and leave then 204, listed by join time, and every change raises the ETag`() {
            val team = Team()
            val session = team.open()
            val tag = team.moderator.getSession(team.board.id, session.id).etag

            assertEquals(HttpStatus.NO_CONTENT, team.annaApi.joinSession(team.board.id, session.id).status, "Anna")
            assertEquals(HttpStatus.NO_CONTENT, team.benApi.joinSession(team.board.id, session.id).status, "Ben")
            assertEquals(HttpStatus.NO_CONTENT, team.annaApi.joinSession(team.board.id, session.id).status, "again: nothing changes")
            val joined = team.look(team.cleoApi, session)
            assertEquals(HttpStatus.NO_CONTENT, team.benApi.leaveSession(team.board.id, session.id).status, "Ben leaves")

            assertEquals(listOf("Anna", "Ben"), joined.seats.map { it.displayName }, "by join time")
            assertEquals(listOf("Anna"), team.look(team.cleoApi, session).seats.map { it.displayName }, "Ben left")
            assertEquals(HttpStatus.OK, team.moderator.getSession(team.board.id, session.id, tag).status, "the old ETag is stale")
            assertEquals(team.look(team.annaApi, session).me.seatId, joined.seats.first().id, "Anna's own seat in me")
            assertNull(team.look(team.cleoApi, session).me.seatId, "Cleo has none")
        }

        @Test
        fun `when a viewer joins then 403 LIBRARY_BOARD_ACCESS_DENIED - after the session was found`() {
            val team = Team()
            val session = team.open()

            team.viewerApi.joinSession(team.board.id, session.id)
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "viewer")
            team.viewerApi.joinSession(team.board.id, Uuid.random()).assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_SESSION_NOT_FOUND,
                "an unknown session is 404 before the role (C2)")
        }

        @Test
        fun `when the session has started then join and leave are 409 PLANNING_SESSION_WRONG_STATE`() {
            val team = Team()
            val session = team.started(team.open(), team.annaApi, team.benApi)

            team.cleoApi.joinSession(team.board.id, session.id)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "join")
            team.annaApi.leaveSession(team.board.id, session.id)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "leave")
        }

        @Test
        fun `when more seats than cards are picked then 400 seatIds in both modes, after the state check (C3)`() {
            val team = Team()
            listOf(newSession(EstimationMode.MAGIC, storyCards(2)), newSession(items = storyCards(2), settings = rotationSettings(1)))
                .forEach { request ->
                    val session = team.open(request)
                    listOf(team.annaApi, team.benApi, team.cleoApi).forEach { it.joinSession(team.board.id, session.id) }

                    val reply = team.moderator.startSession(team.board.id, session.id, team.seats(session))

                    reply.assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, "${request.mode}")
                    assertEquals(listOf("seatIds"), reply.error().violations.orEmpty().map { it.field }, "${request.mode}: field")
                }
        }

        @Test
        fun `when somebody but the moderator or the owner starts then 403, the owner may`() {
            val team = Team()
            val session = team.open()
            listOf(team.annaApi, team.benApi).forEach { it.joinSession(team.board.id, session.id) }
            val other = user("Eli").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }.act()

            other.startSession(team.board.id, session.id, team.seats(session))
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "another editor")
            team.annaApi.startSession(team.board.id, session.id, team.seats(session))
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "a seat")
            assertEquals(HttpStatus.OK, team.ownerApi.startSession(team.board.id, session.id, team.seats(session)).status, "the OWNER")
        }

        @Test
        fun `when the moderator lost the editor role then they are not the moderator any more`() {
            val team = Team()
            val session = team.open()
            team.owner.status("PUT", "/api/boards/${team.board.id}/members/users/${team.editor.id}", MemberUpdate(GrantRole.COMMENTER))

            team.moderator.cancelSession(team.board.id, session.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "checked per request (E13)")
            assertFalse(team.look(team.moderator, session).me.moderator, "me says so too")
        }
    }

    @Nested
    inner class Rotation {

        @Test
        fun `when a rotation runs from the lobby to DONE then holders keep or change values with reasons and REVIEW reveals them`() =
            runBlocking {
                val team = Team()
                val seats = listOf(team.annaApi, team.benApi, team.cleoApi)
                val session = team.started(
                    team.open(newSession(items = storyCards(3), settings = rotationSettings(rounds = 2))),
                    *seats.toTypedArray(),
                )
                assertEquals(EstimationSessionState.ROTATING to 0, session.state to session.round, "round 0")
                assertTrue(session.items.none { it.mine }, "the moderator holds nothing")
                assertEquals(3 to 0, checkNotNull(auditLog.history("session", session.id.toString()).last().detailsAs<SessionStarted>())
                    .let {
                    it.memberSeats to it.guestSeats
                }, "audited: three members, no guest")

                // round 0: every holder enters a first value, no reason needed
                seats.zip(listOf("3", "5", "8")).forEach { (who, value) ->
                    val card = team.mine(who, session).single()
                    assertNull(card.currentValue, "the first holder sees no previous value")
                    val reply = who.estimateCard(team.board.id, session.id, card.id, value, round = 0)
                    assertEquals(HttpStatus.OK, reply.status, "entry, body ${reply.body}")
                    reply.assertNoStore("the answer holds a secret value")
                    assertEquals(value to false, read.entry(reply).let { it.value to it.kept }, "myEntry only")
                }
                team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)

                // round 1: Anna keeps, Ben changes without and with a reason, Cleo changes with one
                val annaCard = team.mine(team.annaApi, session).single()
                val previous = checkNotNull(annaCard.currentValue) { "the holder sees the previous value" }
                assertTrue(
                    read.entry(team.annaApi.estimateCard(team.board.id, session.id, annaCard.id, previous, "ignored", 1)).kept,
                    "kept",
                )
                val benCard = team.mine(team.benApi, session).single()
                team.benApi.estimateCard(team.board.id, session.id, benCard.id, "21", round = 1)
                    .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_REASON_REQUIRED, "a change needs a reason")
                team.benApi.estimateCard(team.board.id, session.id, benCard.id, "21", "too risky", 1)
                val cleoCard = team.mine(team.cleoApi, session).single()
                team.cleoApi.estimateCard(team.board.id, session.id, cleoCard.id, "1", "trivial", 1)
                val review = read.session(team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 1))

                assertEquals(EstimationSessionState.REVIEW to 1, review.state to review.round, "REVIEW keeps the last round")
                val result = checkNotNull(review.items.single { it.id == benCard.id }.result)
                assertEquals(2, result.propertyEntries.size, "two entries")
                assertTrue(result.propertyEntries.all { it.displayName == null }, "anonymous: no names")
                assertTrue(result.propertyEntries.any { it.reason == "too risky" }, "the reason is revealed")
                team.moderator.decideCard(team.board.id, session.id, benCard.id, "13")
                    .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_DECISION_INVALID, "only entered values")
                assertEquals(
                    HttpStatus.NO_CONTENT,
                    team.moderator.decideCard(team.board.id, session.id, benCard.id, "21").status,
                    "decided",
                )
                val done = read.session(team.moderator.finishSession(team.board.id, session.id))
                assertEquals(EstimationSessionState.DONE to "21", done.state to done.items.single { it.id == benCard.id }.decision, "done")
                assertEquals(1 to 0, checkNotNull(auditLog.history("session", session.id.toString()).last().detailsAs<SessionFinished>())
                    .let {
                    it.decisions to it.overridden
                }, "finished with counts")
            }

        @Test
        fun `when a seat touches a card it does not hold then it is always 409 PLANNING_ITEM_NOT_HELD, never REASON_REQUIRED (C2)`() {
            val team = Team()
            val session = team.started(team.open(newSession(items = storyCards(3))), team.annaApi, team.benApi, team.cleoApi)
            listOf(team.annaApi, team.benApi, team.cleoApi).forEach { who ->
                team.mine(who, session).forEach { who.estimateCard(team.board.id, session.id, it.id, "5", round = 0) }
            }
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)

            val bodies = team.notMine(team.annaApi, session).map { card ->
                val reply = team.annaApi.estimateCard(team.board.id, session.id, card.id, "21")
                reply.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ITEM_NOT_HELD, "card ${card.position}")
                reply.error().params
            }

            assertEquals(setOf(setOf("sessionId", "itemId")), bodies.map { it.orEmpty().keys }.toSet(), "the same body for every card")
        }

        @Test
        fun `when the session is not anonymous then REVIEW names who entered what`() {
            val team = Team()
            val session = team.started(team.open(newSession(items = storyCards(2), anonymous = false)), team.annaApi, team.benApi)
            team.mine(team.annaApi, session).forEach { team.annaApi.estimateCard(team.board.id, session.id, it.id, "3") }
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)
            val review = read.session(team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 1))

            val named = review.items.flatMap { it.result?.propertyEntries.orEmpty() }

            assertEquals(listOf("Anna" to false), named.map { it.displayName to it.guest }, "with the name")
        }
    }

    @Nested
    inner class Magic {

        @Test
        fun `when a magic session runs then placements are private, moves public without the mover, REVIEW has trails and marks`() =
            runBlocking {
                val team = Team()
                val session = team.started(team.open(newSession(EstimationMode.MAGIC, storyCards(4))), team.annaApi, team.benApi)
                assertEquals(EstimationSessionState.PLACING, session.state, "placing")

                val annaCards = team.mine(team.annaApi, session)
                assertEquals(2, annaCards.size, "four cards dealt to two seats")
                annaCards.forEach { assertEquals(HttpStatus.NO_CONTENT, team.annaApi.placeCard(
                    team.board.id,
                    session.id,
                    it.id,
                    "5",
                ).status, "placed") }
                team.notMine(team.annaApi, session).forEach {
                    team.annaApi.placeCard(team.board.id, session.id, it.id, "5")
                        .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ITEM_NOT_HELD, "another seat's card")
                }
                assertTrue(team.look(team.benApi, session).items.all { it.column == null }, "Ben sees none of Anna's columns")
                assertTrue(team.look(team.moderator, session).items.all { it.column == null }, "nor does the moderator (E4)")
                assertEquals(listOf(true, false), team.look(team.moderator, session).seats.map { it.done }, "only progress per seat")
                team.mine(team.benApi, session).forEach { team.benApi.placeCard(team.board.id, session.id, it.id, "?") }
                team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.PLACING, 0)

                val moving = team.look(team.cleoApi, session)
                assertEquals(EstimationSessionState.MOVING, moving.state, "moving")
                assertEquals(setOf("5", "?"), moving.items.map { it.column }.toSet(), "everybody sees the columns now")
                assertEquals(setOf(true, false), moving.items.map { it.marked }.toSet(), "the parked ones are marked")
                val card = annaCards.first()
                val tag = team.annaApi.getSession(team.board.id, session.id).etag
                assertEquals(HttpStatus.NO_CONTENT, team.benApi.placeCard(team.board.id, session.id, card.id, "8").status, "Ben moves")
                assertEquals(HttpStatus.OK, team.annaApi.getSession(team.board.id, session.id, tag).status, "every move raises the version")
                val moved = team.look(team.annaApi, session).items.single { it.id == card.id }
                assertEquals("8" to 1, moved.column to moved.moveCount, "the column and the count, never who")

                val review = read.session(team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.MOVING, 0))
                assertEquals(listOf("5", "8"), review.items.single { it.id == card.id }.result?.moveTrail, "the trail")
                team.moderator.decideCard(team.board.id, session.id, card.id, "coffee")
                    .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_DECISION_INVALID, "coffee")
                team.moderator.decideCard(team.board.id, session.id, card.id, "13")
                assertEquals(true, team.look(team.annaApi, session).items.single { it.id == card.id }.overridden, "overridden")
                val override = checkNotNull(auditLog.history("session", session.id.toString()).last().detailsAs<DecisionOverridden>())
                assertEquals(card.id.toString(), override.itemId, "audited without the value")
                val stored = database.sql("select count(*) as n from planning.estimation_move where session_id = cast(:id as uuid) " +
                    "and seat_id is not null").bind("id", session.id.toString()).fetch().one().block()!!["n"] as Long
                assertEquals(0L, stored, "no mover is kept after MOVING (E4)")
            }

        @Test
        fun `when the expected state of a placement is not the current one then 409 instead of landing in the next phase (E14)`() {
            val team = Team()
            val session = team.started(team.open(newSession(EstimationMode.MAGIC, storyCards(2))), team.annaApi, team.benApi)
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.PLACING, 0)

            val card = session.items.first()
            team.annaApi.placeCard(team.board.id, session.id, card.id, "3", EstimationSessionState.PLACING)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "PLACING is over")
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.PLACING, 0)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "a double click never skips MOVING")
        }
    }

    @Nested
    inner class Visibility {

        @Test
        fun `when anybody looks before REVIEW then no card they do not hold differs from another one (E3)`() {
            val team = Team()
            val session = team.open(newSession(items = storyCards(4), settings = rotationSettings(rounds = 2)))
            listOf(team.annaApi, team.benApi, team.cleoApi).forEach { it.joinSession(team.board.id, session.id) }
            val two = team.look(team.moderator, session).seats.take(2).map { it.id }.toSet() // Cleo watches
            val started = team.moderator.startSession(team.board.id, session.id, two)
            team.mine(team.annaApi, session).take(1).forEach { team.annaApi.estimateCard(team.board.id, session.id, it.id, "3") }
            val advanced = team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)
            team.mine(team.benApi, session).take(1).forEach { team.benApi.estimateCard(team.board.id, session.id, it.id, "8", "x") }

            val answers = listOf(started, advanced) + listOf(team.moderator, team.ownerApi, team.cleoApi, team.annaApi, team.benApi)
                .map { it.getSession(team.board.id, session.id) }
            answers.forEach { reply ->
                val foreign = read.itemTrees(reply).filter { it["mine"] == false }.map { it - setOf("id", "ref", "title", "position") }
                assertEquals(1, foreign.toSet().size, "every card not held looks the same: ${foreign.toSet()}")
                assertFalse(reply.body.contains("slot") || reply.body.contains("entryCount") || reply.body.contains("placed"),
                    "no slot, no per-card progress")
            }
        }

        @Test
        fun `when magic is placing then no answer differs per card a caller was not dealt - also after a placement (E3)`() {
            val team = Team()
            val session = team.open(newSession(EstimationMode.MAGIC, storyCards(4)))
            listOf(team.annaApi, team.benApi).forEach { it.joinSession(team.board.id, session.id) }
            val started = team.moderator.startSession(team.board.id, session.id, team.seats(session))
            val annaCard = team.mine(team.annaApi, session).first()
            team.annaApi.placeCard(team.board.id, session.id, annaCard.id, "8")

            val answers = listOf(started) + listOf(team.moderator, team.ownerApi, team.cleoApi, team.annaApi, team.benApi)
                .map { it.getSession(team.board.id, session.id) }
            answers.forEach { reply ->
                val foreign = read.itemTrees(reply).filter { it["mine"] == false }.map { it - setOf("id", "ref", "title", "position") }
                assertEquals(1, foreign.toSet().size, "every card not dealt to the caller looks the same: ${foreign.toSet()}")
                assertFalse(reply.body.contains("\"column\":\"8\"") && reply != answers[4], "Anna's column only for Anna")
            }
        }

        @Test
        fun `when a guest places or estimates then no span of the request names the guest, its link, a user or the card (B1)`() {
            val team = Team()
            val (token, linkId) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val session = openAsGuest(client, json, token, "Gus")
            val guest = guestActor(client, json, session)
            val payload = String(Base64.getUrlDecoder().decode(session.accessToken.split('.')[1]))
            val sub = checkNotNull(Regex("\"sub\"\\s*:\\s*\"([^\"]+)\"").find(payload)).groupValues[1]
            val magic = team.started(team.open(newSession(EstimationMode.MAGIC, storyCards(2))), team.annaApi, guest)
            val rotation = team.started(team.open(newSession(items = storyCards(2))), team.annaApi, guest)
            val magicCard = team.mine(guest, magic).single().id
            val rotationCard = team.mine(guest, rotation).single().id
            val secrets = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").findAll(sub).map { it.value }.toList() +
                listOf(linkId, team.anna.id, team.owner.id, team.editor.id, magicCard, rotationCard).map { it.toString() }

            spans.clear()
            assertEquals(HttpStatus.NO_CONTENT, guest.placeCard(team.board.id, magic.id, magicCard, "5").status, "placed")
            assertEquals(HttpStatus.OK, guest.estimateCard(team.board.id, rotation.id, rotationCard, "5").status, "estimated")
            await().atMost(5.seconds.toJavaDuration()).until {
                spans.finished.count { span -> span.attributes.asMap().values.any { it.toString().contains("{itemId}") } } >= 2
            }

            val values = spans.finished.flatMap { span -> span.attributes.asMap().map { (key, value) -> "${span.name} $key=$value" } }
            assertTrue(secrets.isNotEmpty(), "the guest's sub holds an id")
            secrets.forEach { secret ->
                assertEquals(emptyList(), values.filter { it.contains(secret) }, "no span attribute holds $secret")
            }
            assertTrue(values.any { it.contains("/items/{itemId}/placement") }, "the server span shows the masked path: $values")
        }

        @Test
        fun `when a guest without a seat asks about a session in REVIEW then every operation is 404 with only the session id (E9)`() {
            val team = Team()
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val guest = guestActor(client, json, openAsGuest(client, json, token, "Gus"))
            val session = team.started(team.open(newSession(items = storyCards(2), settings = rotationSettings(rounds = 1))),
                team.annaApi, team.benApi)
            val tag = team.annaApi.getSession(team.board.id, session.id).etag
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)
            val current = team.annaApi.getSession(team.board.id, session.id).etag
            val card = session.items.first().id

            listOf(
                guest.getSession(team.board.id, session.id, current), guest.joinSession(team.board.id, session.id),
                guest.leaveSession(team.board.id, session.id), guest.placeCard(team.board.id, session.id, card, "3"),
                guest.estimateCard(team.board.id, session.id, card, "3"),
            ).forEach { reply ->
                reply.assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_SESSION_NOT_FOUND, "E9")
                assertEquals(mapOf("sessionId" to session.id.toString()), reply.error().params, "only the session id, a 404 not a 304")
            }
            assertTrue(read.sessions(guest.listSessions(team.board.id)).items.isEmpty(), "not listed for the guest")
            assertNotNull(tag, "the members kept polling")
        }

        @Test
        fun `when the answer is read then no user id of a seat appears, only the moderator's for members and nothing for guests`() {
            val team = Team()
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val guest = guestActor(client, json, openAsGuest(client, json, token, "Gus"))
            val session = team.open()
            team.annaApi.joinSession(team.board.id, session.id)

            val member = team.cleoApi.getSession(team.board.id, session.id).body
            val forGuest = guest.getSession(team.board.id, session.id)

            assertFalse(member.contains(team.anna.id.toString()), "no seat's user id")
            assertTrue(member.contains(team.editor.id.toString()), "the moderator's id for members")
            assertNull(read.session(forGuest).moderatorId, "left out for guests")
            assertFalse(forGuest.body.contains(team.editor.id.toString()), "no member id anywhere for a guest")
        }
    }

    @Nested
    inner class OrderOfRefusals {

        @Test
        fun `when a VIEWER-link guest calls with an unknown session then 403 comes before the 404 of the session (C2)`() {
            val team = Team()
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.VIEWER)
            val guest = guestActor(client, json, openAsGuest(client, json, token, "Vera"))

            guest.getSession(team.board.id, Uuid.random()).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "get")
            guest.listSessions(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "list")
            guest.joinSession(team.board.id, Uuid.random()).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "join")
        }

        @Test
        fun `when the steps fail one after the other then the codes come in the order of C2`() {
            val team = Team()
            val session = team.open(newSession(items = storyCards(3), settings = rotationSettings(rounds = 2)))
            listOf(team.annaApi, team.benApi, team.cleoApi).forEach { it.joinSession(team.board.id, session.id) }
            team.moderator.startSession(team.board.id, session.id, team.look(team.moderator, session).seats.take(2).map { it.id }.toSet())
            team.mine(team.annaApi, session).forEach { team.annaApi.estimateCard(team.board.id, session.id, it.id, "3") }
            team.mine(team.benApi, session).forEach { team.benApi.estimateCard(team.board.id, session.id, it.id, "3") }
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)
            val own = team.mine(team.annaApi, session).first().id
            val foreign = team.notMine(team.annaApi, session).first().id
            val unknown = Uuid.random()

            team.annaApi.estimateCard(team.board.id, session.id, unknown, "21")
                .assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_SESSION_NOT_FOUND, "card")
            assertEquals(
                unknown.toString(),
                team.annaApi.estimateCard(team.board.id, session.id, unknown, "x").error().params?.get("itemId"),
                "itemId",
            )
            team.viewerApi.estimateCard(team.board.id, session.id, foreign, "21")
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "role")
            team.cleoApi.estimateCard(team.board.id, session.id, foreign, "nope", round = 0)
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.PLANNING_NOT_SEATED, "a watcher: seat before state, card and value")
            team.annaApi.estimateCard(team.board.id, session.id, foreign, "nope", round = 0)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "state before card")
            team.annaApi.estimateCard(team.board.id, session.id, foreign, "nope", round = 1)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ITEM_NOT_HELD, "card before value")
            team.annaApi.estimateCard(team.board.id, session.id, own, "nope", round = 1)
                .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_VALUE_INVALID, "value before reason")
            team.annaApi.estimateCard(team.board.id, session.id, own, "21", round = 1)
                .assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_REASON_REQUIRED, "reason last")
            team.annaApi.placeCard(team.board.id, session.id, own, "3")
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "a rotation has no placement")
            val error = team.annaApi.estimateCard(team.board.id, session.id, own, "21", round = 1)
            assertTrue(error.headers.cacheControl.orEmpty().contains("no-store"), "an error answer is not stored either")
        }
    }

    @Nested
    inner class Polling {

        @Test
        fun `when nothing changed then 304 with ETag, no-store and Vary - a star or a stale tag gets 200`() {
            val team = Team()
            val session = team.open()
            val first = team.annaApi.getSession(team.board.id, session.id)
            val tag = assertNotNull(first.etag, "ETag")

            val again = team.annaApi.getSession(team.board.id, session.id, tag)
            val star = team.annaApi.getSession(team.board.id, session.id, "*")
            val stale = team.annaApi.getSession(team.board.id, session.id, "W/\"0\"")

            assertEquals(HttpStatus.NOT_MODIFIED to "", again.status to again.body, "304 without a body")
            assertEquals(tag, again.etag, "the same tag")
            again.assertNoStore("304")
            first.assertNoStore("200")
            assertEquals(HttpStatus.OK to HttpStatus.OK, star.status to stale.status, "a star is no match")
            assertEquals("W/\"${read.session(first).version}\"", tag, "weak ETag of the version")
        }

        @Test
        fun `when a user polls more than 75 times a minute then 429 with Retry-After - 304 counts as well`() {
            val team = Team()
            val session = team.open()
            val tag = team.annaApi.getSession(team.board.id, session.id).etag
            repeat(74) { team.annaApi.getSession(team.board.id, session.id, tag) }

            val over = team.annaApi.getSession(team.board.id, session.id, tag)

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, over.status, "76th")
            assertNotNull(over.headers.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }

        @Test
        fun `when a seat places or estimates more often than allowed then 429 (E17)`() {
            val team = Team()
            val session = team.started(team.open(newSession(EstimationMode.MAGIC, storyCards(2))), team.annaApi, team.benApi)
            val card = team.mine(team.annaApi, session).single()
            repeat(60) { team.annaApi.placeCard(team.board.id, session.id, card.id, if (it % 2 == 0) "3" else "5") }

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, team.annaApi.placeCard(team.board.id, session.id, card.id, "8").status, "61st")
            assertEquals(HttpStatus.NO_CONTENT, team.benApi.placeCard(
                team.board.id,
                session.id,
                team.mine(team.benApi, session).single().id,
                "8",
            ).status,
                "another user has their own limit")
        }
    }

    @Nested
    inner class Guests {

        private fun guestOf(team: Team, role: GrantRole, name: String = "Gus"): Pair<Actor, Uuid> {
            val (token, linkId) = guestLink(team.owner, "boards", team.board.id, role)
            return guestActor(client, json, openAsGuest(client, json, token, name)) to linkId
        }

        @Test
        fun `when a guest holds a COMMENTER link then it lists ACTIVE, joins, estimates - CLOSED and moderator operations are 403`() {
            val team = Team()
            val (guest, _) = guestOf(team, GrantRole.COMMENTER, "Gus Guest")
            val session = team.open(newSession(items = storyCards(2)))

            assertEquals(listOf(session.id), read.sessions(guest.listSessions(team.board.id)).items.map { it.id }, "active")
            guest.listSessions(team.board.id, "CLOSED").assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "closed")
            assertEquals(HttpStatus.NO_CONTENT, guest.joinSession(team.board.id, session.id).status, "join")
            val listed = team.look(team.annaApi, session).seats.single()
            assertEquals("Gus Guest" to true, listed.displayName to listed.guest, "listed as a guest")
            listOf(
                guest.createSession(team.board.id), guest.startSession(team.board.id, session.id, setOf(listed.id)),
                guest.advanceSession(team.board.id, session.id, EstimationSessionState.LOBBY),
                guest.finishSession(team.board.id, session.id),
                guest.cancelSession(team.board.id, session.id), guest.decideCard(team.board.id, session.id, session.items[0].id, "3"),
            ).forEach { it.assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "never a moderator") }

            team.annaApi.joinSession(team.board.id, session.id)
            team.moderator.startSession(team.board.id, session.id, team.seats(session))
            val card = team.mine(guest, session).single()
            assertEquals(HttpStatus.OK, guest.estimateCard(team.board.id, session.id, card.id, "5").status, "a guest estimates")
        }

        @Test
        fun `when a guest holds a VIEWER link then every estimation operation is 403 FORBIDDEN`() {
            val team = Team()
            val session = team.open()
            val (guest, _) = guestOf(team, GrantRole.VIEWER)

            listOf(
                guest.listSessions(team.board.id), guest.getSession(team.board.id, session.id),
                guest.joinSession(team.board.id, session.id),
                guest.leaveSession(team.board.id, session.id), guest.placeCard(team.board.id, session.id, session.items[0].id, "3"),
                guest.estimateCard(team.board.id, session.id, session.items[0].id, "3"),
            )
                .forEach { it.assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "VIEWER link") }
        }

        @Test
        fun `when too many guests of one link join then 409 PLANNING_SESSION_FULL with the per-link limit (E10)`() {
            val team = Team()
            val session = team.open()
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val guests = List(3) { guestActor(client, json, openAsGuest(client, json, token, "G$it")) }
            guests.take(2).forEach { assertEquals(HttpStatus.NO_CONTENT, it.joinSession(team.board.id, session.id).status, "joined") }

            val third = guests[2].joinSession(team.board.id, session.id)

            third.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_FULL, "third guest of one link")
            assertEquals("2", third.error().params?.get("limit"), "per link")
        }

        @Test
        fun `when the link is revoked in a running rotation then the seat leaves, its entries go, the version rises (E11)`() =
            runBlocking {
                val team = Team()
                val (guest, linkId) = guestOf(team, GrantRole.COMMENTER, "Rex ${Uuid.random().toString().take(4)}")
                val session = team.started(team.open(newSession(items = storyCards(3))), team.annaApi, guest)
                team.mine(guest, session).forEach { guest.estimateCard(team.board.id, session.id, it.id, "8") }
                val before = team.look(team.annaApi, session)

                assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/links/$linkId"), "revoked")

                val after = team.look(team.annaApi, session)
                assertEquals(listOf("Anna"), after.seats.map { it.displayName }, "the guest's seat is not listed")
                assertEquals(before.version + 1, after.version, "the version rises")
                val left = database.sql("select count(*) as n from planning.estimation_entry where session_id = cast(:id as uuid)")
                    .bind("id", session.id.toString()).fetch().one().block()!!["n"] as Long
                assertEquals(0L, left, "its entries and reasons are gone")
                assertEquals(HttpStatus.UNAUTHORIZED, guest.getSession(team.board.id, session.id).status, "and the guest is out")
            }

        @Test
        fun `when the link is revoked in the lobby then its seat is deleted`() {
            val team = Team()
            val (guest, linkId) = guestOf(team, GrantRole.EDITOR)
            val session = team.open()
            guest.joinSession(team.board.id, session.id)

            team.owner.status("DELETE", "/api/links/$linkId")

            assertTrue(team.look(team.annaApi, session).seats.isEmpty(), "gone")
        }
    }

    @Nested
    inner class Lifecycle {

        @Test
        fun `when a session is cancelled then its entries are deleted at once and the answer shows no results`() = runBlocking {
            val team = Team()
            val session = team.started(team.open(newSession(items = storyCards(2))), team.annaApi, team.benApi)
            team.mine(team.annaApi, session).forEach { team.annaApi.estimateCard(team.board.id, session.id, it.id, "3") }

            val cancelled = read.session(team.moderator.cancelSession(team.board.id, session.id))

            assertEquals(EstimationSessionState.CANCELLED, cancelled.state, "cancelled")
            assertTrue(cancelled.items.all { it.result == null && it.decision == null }, "nothing to show")
            val left = database.sql("select count(*) as n from planning.estimation_entry where session_id = cast(:id as uuid)")
                .bind("id", session.id.toString()).fetch().one().block()!!["n"] as Long
            assertEquals(0L, left, "deleted (E22)")
            team.moderator.cancelSession(team.board.id, session.id)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "final")
        }

        @Test
        fun `when a board goes to the trash then its sessions are 404, a purge deletes them with everything in them`() = runBlocking {
            val team = Team()
            val session = team.started(team.open(newSession(items = storyCards(2))), team.annaApi, team.benApi)

            assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/boards/${team.board.id}"), "to the trash")
            team.ownerApi.getSession(team.board.id, session.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "trash")
            assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/trash/boards/${team.board.id}"), "purged")

            listOf("estimation_seat", "estimation_item").forEach { table ->
                val left = database.sql("select count(*) as n from planning.$table where session_id = cast(:id as uuid)")
                    .bind("id", session.id.toString()).fetch().one().block()!!["n"] as Long
                assertEquals(0L, left, "$table")
            }
        }

        @Test
        fun `when closed sessions pile up then a create keeps at most the configured number`() {
            val team = Team()
            val sessions = (1..3).map { team.open().also { team.moderator.cancelSession(team.board.id, it.id) } }

            team.open()

            val closed = read.sessions(team.moderator.listSessions(team.board.id, "CLOSED")).items.map { it.id }
            assertEquals(2, closed.size, "two kept")
            assertFalse(sessions.first().id in closed, "the oldest went first")
        }

        @Test
        fun `when a seat's user was deleted then it reads Deleted user`() {
            val team = Team()
            val session = team.open()
            team.annaApi.joinSession(team.board.id, session.id)
            database.sql("delete from users.user_profile where id = cast(:id as uuid)").bind("id", team.anna.id.toString()).then().block()

            assertEquals(listOf("Deleted user"), team.look(team.cleoApi, session).seats.map { it.displayName }, "deleted")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { GuestIntegrationTest.generatedKey() }
        }
    }
}
