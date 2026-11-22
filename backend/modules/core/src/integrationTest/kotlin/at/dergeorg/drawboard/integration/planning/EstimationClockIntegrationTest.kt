package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.EstimationMode
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionState
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.GuestIntegrationTest
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionCancelled
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.http.HttpStatus
import org.springframework.r2dbc.core.DatabaseClient
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

/** The application clock of [EstimationClockIntegrationTest]: the real time plus an offset the test moves, in microseconds. */
class ShiftedClock : Clock {

    @Volatile
    private var offset: Duration = Duration.ZERO

    fun advanceBy(duration: Duration) {
        offset += duration
    }

    override fun now(): Instant {
        val now = Clock.System.now() + offset
        return Instant.fromEpochSeconds(now.epochSeconds, now.nanosecondsOfSecond / NANOS_PER_MICRO * NANOS_PER_MICRO)
    }

    private companion object {
        const val NANOS_PER_MICRO = 1000
    }
}

/**
 * The server clock of the estimation sessions end to end (E14, E15, E22): deadlines applied by the next request without grace and
 * before the ETag comparison, the idle cancel, the retention of single values. The application clock is shifted forward by the test;
 * user tokens are checked against the real time, so they stay valid. Members only.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "management.otlp.metrics.export.enabled=false",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(EstimationClockIntegrationTest.Clocks::class)
class EstimationClockIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val database: DatabaseClient,
    private val auditLog: AuditLog,
    private val clock: ShiftedClock,
    private val estimation: EstimationUseCase,
) {

    @TestConfiguration(proxyBeanMethods = false)
    class Clocks {
        @Bean
        @Primary
        fun shiftedClock() = ShiftedClock()
    }

    private val read = EstimationJson(json)

    private inner class Team {
        val owner = SharingUser(client, port, "Olga")
        val anna = SharingUser(client, port, "Anna")
        val ben = SharingUser(client, port, "Ben")
        val board = owner.createBoard("Sprint").also { board ->
            listOf(anna, ben).forEach { owner.grantUser("boards", board.id, it, GrantRole.COMMENTER) }
        }
        val moderator = owner.actor(json)
        val annaApi = anna.actor(json)
        val benApi = ben.actor(json)

        fun started(mode: EstimationMode = EstimationMode.ROTATION, anonymous: Boolean? = null): EstimationSession {
            val session = moderator.openSession(read, board.id, newSession(mode, storyCards(2), anonymous = anonymous))
            listOf(annaApi, benApi).forEach { it.joinSession(board.id, session.id) }
            val seats = moderator.lookAt(read, board.id, session.id).seats.map { it.id }.toSet()
            return read.session(moderator.startSession(board.id, session.id, seats))
        }

        fun look(session: EstimationSession) = moderator.lookAt(read, board.id, session.id)
    }

    @Test
    fun `when a round's deadline passes then the next poll applies it - also for an unchanged ETag - and a late entry is 409`() {
        val team = Team()
        val session = team.started()
        val tag = team.annaApi.getSession(team.board.id, session.id).etag
        val card = team.annaApi.lookAt(read, team.board.id, session.id).items.single { it.mine }

        clock.advanceBy(61.seconds)
        val polled = team.annaApi.getSession(team.board.id, session.id, tag)
        val late = team.annaApi.estimateCard(team.board.id, session.id, card.id, "5", round = 0)

        assertEquals(HttpStatus.OK, polled.status, "a 304 never hides a due transition")
        val round1 = read.session(polled)
        assertEquals(EstimationSessionState.ROTATING to 1, round1.state to round1.round, "round 1")
        assertEquals(session.phaseEndsAt?.plus(60.seconds), round1.phaseEndsAt, "the next deadline counts from the old one")
        late.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_SESSION_WRONG_STATE, "no grace (E14)")
    }

    @Test
    fun `when every deadline of a magic session passed then one poll leads through MOVING into REVIEW`() {
        val team = Team()
        val session = team.started(EstimationMode.MAGIC)

        clock.advanceBy(61.seconds)
        assertEquals(EstimationSessionState.MOVING, team.look(session).state, "moving")
        clock.advanceBy(120.seconds)
        val review = team.look(session)

        assertEquals(EstimationSessionState.REVIEW, review.state, "review")
        assertTrue(review.items.all { it.marked == true }, "nothing was placed: every card is marked")
    }

    @Test
    fun `when a lobby has been idle for a day then it is cancelled on the next request and audited as idle (E22)`() = runBlocking {
        val team = Team()
        val session = team.moderator.openSession(read, team.board.id)

        clock.advanceBy(24.hours + 1.seconds)
        val listed = read.sessions(team.moderator.listSessions(team.board.id, "CLOSED")).items

        assertEquals(listOf(session.id to EstimationSessionState.CANCELLED), listed.map { it.id to it.state }, "cancelled lazily")
        assertTrue(checkNotNull(auditLog.history("session", session.id.toString()).last().detailsAs<SessionCancelled>()).idle, "idle")
    }

    @Test
    fun `when a session has been DONE for 30 days then answers hold no single value and the purge reduces it to numbers (E22)`() =
        runBlocking {
            val team = Team()
            val session = team.started(anonymous = false)
            listOf(team.annaApi, team.benApi).forEach { who ->
                who.lookAt(read, team.board.id, session.id).items.filter { it.mine }
                    .forEach { who.estimateCard(team.board.id, session.id, it.id, "5") }
            }
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 0)
            team.moderator.advanceSession(team.board.id, session.id, EstimationSessionState.ROTATING, 1)
            team.moderator.finishSession(team.board.id, session.id)
            assertEquals(1, team.look(session).items.first().result?.propertyEntries?.size, "one entry while young")

            clock.advanceBy(30.days + 1.seconds)
            val old = team.look(session)
            val reduced = estimation.reduceExpired(clock.now())

            assertTrue(old.items.all { it.result?.propertyEntries.isNullOrEmpty() }, "no single value in the answer")
            assertEquals(5.0, old.items.first().result?.average, "the numbers stay")
            assertTrue(reduced >= 1, "the purge reduced it")
            val linked = database.sql(
                "select count(*) as n from planning.estimation_entry where session_id = cast(:id as uuid) and seat_id is not null",
            ).bind("id", session.id.toString()).fetch().one().block()!!["n"] as Long
            assertEquals(0L, linked, "no entry is tied to a seat any more")
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
