package at.dergeorg.drawboard.integration.collab

import at.dergeorg.drawboard.integration.multipartForm
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.storage.model.SnapshotStored
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.contract.model.Board
import at.dergeorg.drawboard.contract.model.CollabTicket
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.NewBoard
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditLog
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import io.micrometer.core.instrument.MeterRegistry
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.context.annotation.Primary
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * The collaboration end to end on a real port: really signed tokens, tickets over REST, a real Reactor Netty
 * WebSocket client, PostgreSQL for the log and the snapshots. Limits are turned down in the properties so the compaction and the
 * 413 need a few bytes, not megabytes (the defaults are covered by the unit tests).
 *
 * The library knows only owners so far. To get another role than OWNER at the handshake, [RoleOverrides] lets a test
 * change what the port answers "after the ticket was issued" - exactly the situation S2.2 is about.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "management.otlp.metrics.export.enabled=false",
        "collab.compaction-entries=3",
        "collab.sweep-seconds=1",
        "collab.max-snapshot-bytes=1024",
        "spring.webflux.multipart.max-disk-usage-per-part=1KB",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
@Import(CollabIntegrationTest.RoleOverrides::class)
class CollabIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val roleOverrides: RoleOverrides,
    private val auditLog: AuditLog,
    private val meters: MeterRegistry,
) {

    /** Answers like the real port (library) unless a test pins a role for a (board, user). */
    @TestConfiguration(proxyBeanMethods = false)
    class RoleOverrides {
        val pinned = ConcurrentHashMap<Pair<Uuid, Uuid>, CollabRole>()

        /** (board, user) pairs that lost their role since the ticket was issued. */
        val revoked: MutableSet<Pair<Uuid, Uuid>> = ConcurrentHashMap.newKeySet()

        @Bean
        @Primary
        fun overridingBoardAccess(boards: BoardsUseCase): BoardAccess = object : BoardAccess {
            override suspend fun roleOf(boardId: Uuid, who: Participant): CollabRole? = if ((boardId to who.userId) in revoked) {
                null
            } else {
                pinned[boardId to who.userId] ?: when (boards.roleOf(Caller.User(who.userId, who.groups), boardId)) {
                    BoardRole.OWNER -> CollabRole.OWNER
                    BoardRole.EDITOR -> CollabRole.EDITOR
                    BoardRole.COMMENTER -> CollabRole.COMMENTER
                    BoardRole.VIEWER -> CollabRole.VIEWER
                    null -> null
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------- helpers

    private inner class User(name: String) {
        val subject = "$name-${Uuid.random()}"
        val name = name
        val token: String get() = SignedTokens.token(subject, name)

        fun authed(): WebTestClient = client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer $token").build()

        val id: Uuid by lazy {
            checkNotNull(authed().get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody).id
        }

        fun createBoard(): Board = checkNotNull(
            authed().post().uri("/api/boards").bodyValue(NewBoard("Collab ${Uuid.random()}")).exchange()
                .expectBody<Board>().returnResult().responseBody,
        )

        fun ticket(board: Board): CollabTicket = checkNotNull(
            authed().post().uri("/api/boards/${board.id}/collab-ticket").exchange()
                .expectBody<CollabTicket>().returnResult().responseBody,
        )

        fun open(board: Board, origin: String = PUBLIC_URL): TestSocket =
            TestSocket.connect(port, board.id.toString(), ticket(board).ticket, origin)
    }

    private fun handshake(boardId: Uuid, origin: String?, subprotocols: String?): WebTestClient.ResponseSpec =
        client.get().uri("/api/boards/$boardId/collab")
            .header(HttpHeaders.CONNECTION, "Upgrade").header(HttpHeaders.UPGRADE, "websocket")
            .header("Sec-WebSocket-Version", "13").header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .apply {
                origin?.let { header(HttpHeaders.ORIGIN, it) }
                subprotocols?.let { header("Sec-WebSocket-Protocol", it) }
            }.exchange()

    private fun ByteArray.hexString() = joinToString("") { "%02x".format(it) }

    private fun update(vararg payload: Int) = byteArrayOf(0x01) + ByteArray(payload.size) { payload[it].toByte() }

    // ---------------------------------------------------------------------------------------------------- tests

    @Nested
    inner class Relay {

        @Test
        fun `when two editors of a board exchange updates then each is acked and the other receives it with its seq`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val first = alice.open(board)
            val second = alice.open(board)
            val join = first.until(ServerFrame.SYNCED).map { it.type }
            assertEquals(listOf(ServerFrame.WELCOME, ServerFrame.SYNCED), join, "join of the first")
            second.until(ServerFrame.SYNCED)

            first.send(update(1, 2))
            assertEquals(1L, first.until(ServerFrame.ACK).last().varUint(), "first update gets seq 1")
            second.send(update(3, 4))

            val relayed = second.until(ServerFrame.UPDATE).last()
            assertEquals(1L, relayed.varUint(), "relayed with its seq")
            assertContentEquals(byteArrayOf(1, 2), relayed.rest(), "relayed unchanged")
            assertEquals(2L, second.until(ServerFrame.ACK).last().varUint(), "second update gets seq 2")
            val back = first.until(ServerFrame.UPDATE).last()
            assertEquals(2L, back.varUint(), "and the first session receives the second's update")
        }

        @Test
        fun `when a third session joins later then it receives the log it missed before SYNCED`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val first = alice.open(board)
            first.until(ServerFrame.SYNCED)
            first.send(update(7))
            first.until(ServerFrame.ACK)

            val frames = alice.open(board).until(ServerFrame.SYNCED)

            assertEquals(listOf(ServerFrame.WELCOME, ServerFrame.UPDATE, ServerFrame.SYNCED), frames.map { it.type }, "join frames")
            assertEquals(1L, frames[1].varUint(), "log entry seq")
            assertEquals(1L, frames[2].varUint(), "head")
        }

        @Test
        fun `when a viewer sends an update then it is dropped and not logged, the session stays open`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val editor = alice.open(board)
            editor.until(ServerFrame.SYNCED)
            val ticket = alice.ticket(board)
            roleOverrides.pinned[board.id to alice.id] = CollabRole.VIEWER // changed after the ticket was issued

            val viewer = TestSocket.connect(port, board.id.toString(), ticket.ticket)
            assertTrue(viewer.next().varString().startsWith("""{"role":"VIEWER""""), "the role is resolved again at the handshake")
            viewer.until(ServerFrame.SYNCED)
            viewer.send(update(9))
            viewer.send(0x03)
            assertEquals(ServerFrame.PONG, viewer.next().type, "the session is alive, the update before the ping was only dropped")
            editor.send(update(1))

            assertEquals(1L, editor.until(ServerFrame.ACK).last().varUint(), "the dropped update took no sequence number")
            roleOverrides.pinned.remove(board.id to alice.id)
        }

        @Test
        fun `when awareness has two entries then it is dropped, a single entry is relayed wrapped with the sender`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val sender = alice.open(board)
            val receiver = alice.open(board)
            sender.until(ServerFrame.SYNCED)
            receiver.until(ServerFrame.SYNCED)
            val twoEntries = "020701077b2261223a317dac0201077b2262223a327d"
            val oneEntry = "012a01247b2275736572223a7b226e616d65223a2278227d2c22637572736f72223a5b312c325d7d"

            sender.send(byteArrayOf(0x02) + twoEntries.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            sender.send(byteArrayOf(0x02) + oneEntry.chunked(2).map { it.toInt(16).toByte() }.toByteArray())

            val relayed = receiver.until(ServerFrame.AWARENESS).last()
            val from = relayed.varString()
            assertTrue(from.contains(""""id":"${alice.id}""""), "From carries the authenticated user id: $from")
            assertTrue(from.contains(""""name":"Alice""""), "From carries the display name from the token: $from")
            assertTrue(from.endsWith(""","clientId":42}"""), "From carries the bound client id: $from")
            assertEquals(oneEntry, relayed.rest().hexString(), "the first relayed awareness is the single entry, as sent")
        }
    }

    @Nested
    inner class Handshake {

        @Test
        fun `when the Origin is not the public URL then 403`() {
            val alice = User("Alice")
            val ticket = alice.ticket(alice.createBoard()).ticket

            val result = handshake(Uuid.random(), origin = "https://evil.example.test", subprotocols = "drawboard.v1, ticket.$ticket")
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.FORBIDDEN, result.status, "wrong origin")
        }

        @Test
        fun `when the subprotocol or the ticket is missing then 400, and without an Origin 403`() {
            val board = Uuid.random()

            assertEquals(HttpStatus.BAD_REQUEST, handshake(board, PUBLIC_URL, null).expectBody<String>().returnResult().status, "no header")
            assertEquals(
                HttpStatus.BAD_REQUEST,
                handshake(board, PUBLIC_URL, "ticket.abc").expectBody<String>().returnResult().status,
                "ticket without drawboard.v1",
            )
            assertEquals(
                HttpStatus.BAD_REQUEST,
                handshake(board, PUBLIC_URL, "drawboard.v1").expectBody<String>().returnResult().status,
                "drawboard.v1 without a ticket",
            )
            assertEquals(
                HttpStatus.BAD_REQUEST,
                handshake(board, PUBLIC_URL, "drawboard.v1, ticket.a, ticket.b").expectBody<String>().returnResult().status,
                "two tickets",
            )
            assertEquals(
                HttpStatus.FORBIDDEN,
                handshake(board, null, "drawboard.v1, ticket.abc").expectBody<String>().returnResult().status,
                "no Origin at all",
            )
        }

        @Test
        fun `when a ticket is used twice, is unknown or belongs to another board then 401`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val ticket = alice.ticket(board).ticket
            val bob = User("Bob")
            val bobsTicket = bob.ticket(bob.createBoard()).ticket
            TestSocket.connect(port, board.id.toString(), ticket).until(ServerFrame.SYNCED)

            val reused = handshake(board.id, PUBLIC_URL, "drawboard.v1, ticket.$ticket").expectBody<ErrorModel>().returnResult()
            val unknown = handshake(board.id, PUBLIC_URL, "drawboard.v1, ticket.${"A".repeat(43)}").expectBody<ErrorModel>().returnResult()
            val foreignBoard = handshake(board.id, PUBLIC_URL, "drawboard.v1, ticket.$bobsTicket").expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.UNAUTHORIZED, reused.status, "a ticket is single use")
            assertEquals(HttpStatus.UNAUTHORIZED, unknown.status, "unknown ticket")
            assertEquals(HttpStatus.UNAUTHORIZED, foreignBoard.status, "a ticket is bound to its board")
        }

        @Test
        fun `when the user lost the role between ticket and handshake then 404`() {
            val alice = User("Alice")
            val board = alice.createBoard()
            val ticket = alice.ticket(board).ticket
            roleOverrides.revoked += board.id to alice.id

            val result = handshake(board.id, PUBLIC_URL, "drawboard.v1, ticket.$ticket").expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "no role at the handshake")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "error code")
            roleOverrides.revoked -= board.id to alice.id
        }

        @Test
        fun `when a token is expired by the time the sweep runs then the session ends with 4401`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val shortLived = SignedTokens.token(alice.subject, "Alice", expiresInSeconds = 3)
            val ticket = checkNotNull(
                client.post().uri("/api/boards/${board.id}/collab-ticket").header(HttpHeaders.AUTHORIZATION, "Bearer $shortLived")
                    .exchange().expectBody<CollabTicket>().returnResult().responseBody,
            )

            val socket = TestSocket.connect(port, board.id.toString(), ticket.ticket)

            assertEquals(4401, socket.closeStatus().code, "the session ends when the token behind the ticket expires")
        }
    }

    @Nested
    inner class Tickets {

        @Test
        fun `when the 61st ticket is requested within a minute then 429 with Retry-After`() {
            val alice = User("Alice")
            val board = alice.createBoard()
            repeat(60) { alice.ticket(board) }

            val result = alice.authed().post().uri("/api/boards/${board.id}/collab-ticket").exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, result.status, "rate limit")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, result.responseBody?.code, "error code")
            val retryAfter = result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER)?.toLongOrNull()
            assertTrue(retryAfter != null && retryAfter in 1..60, "Retry-After seconds: $retryAfter")
        }

        @Test
        fun `when asking for a ticket of a board of someone else then 404`() {
            val board = User("Alice").createBoard()

            val result = User("Bob").authed().post().uri("/api/boards/${board.id}/collab-ticket").exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "no role")
            assertEquals(ErrorCode.LIBRARY_BOARD_NOT_FOUND, result.responseBody?.code, "existence is not revealed")
        }
    }

    @Nested
    inner class Compaction {

        private fun upload(user: User, board: Board, upToSeq: Long, bytes: ByteArray) =
            user.authed().put().uri("/api/boards/${board.id}/snapshot?upToSeq=$upToSeq")
                .multipartForm("snapshot", bytes, "s.bin")
                .exchange()

        @Test
        fun `when the log is long enough then COMPACT arrives and the snapshot upload is accepted once, only for that seq`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val editor = alice.open(board)
            editor.until(ServerFrame.SYNCED)
            repeat(4) { editor.send(update(it)) }

            val upToSeq = editor.until(ServerFrame.COMPACT).last().varUint()
            assertEquals(4L, upToSeq, "COMPACT carries the head")

            val wrongSeq = upload(alice, board, 3, byteArrayOf(1)).expectBody<ErrorModel>().returnResult()
            val accepted = upload(alice, board, upToSeq, byteArrayOf(5, 6)).expectBody<String>().returnResult()
            assertEquals(HttpStatus.CONFLICT, wrongSeq.status, "wrong upToSeq")
            assertEquals(HttpStatus.NO_CONTENT, accepted.status, "accepted")
            val again = upload(alice, board, upToSeq, byteArrayOf(5, 6)).expectBody<ErrorModel>().returnResult()
            assertEquals(HttpStatus.CONFLICT, again.status, "a request is good for one upload")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, again.responseBody?.code, "error code")

            editor.send(update(99))
            editor.until(ServerFrame.ACK)
            val joiner = alice.open(board).until(ServerFrame.SYNCED)
            assertEquals(
                listOf(ServerFrame.WELCOME, ServerFrame.SNAPSHOT, ServerFrame.UPDATE, ServerFrame.SYNCED),
                joiner.map { it.type },
                "a new session gets the snapshot and only the log after it",
            )
            assertEquals(4L, joiner[1].varUint(), "snapshot upToSeq")
            assertContentEquals(byteArrayOf(5, 6), joiner[1].rest(), "snapshot bytes")
            assertEquals(5L, joiner[2].varUint(), "first log entry after the snapshot")

            val audited = auditLog.history("snapshot", board.id.toString()).single()
            assertEquals("collab.snapshot.stored", audited.eventType, "the compaction is audited")
            assertEquals(AuditAction.CREATED, audited.action, "action")
            val details = SnapshotStored(upToSeq = 4, sizeBytes = 2, snapshotsDeleted = 0, logDroppedUpToSeq = 4)
            assertEquals(details, audited.detailsAs<SnapshotStored>(), "what")
            assertEquals(alice.subject, audited.actor.id, "who uploaded it (the token subject, like every audit event)")
        }

        @Test
        fun `when nobody asked then 409 even for a body above the limit, and with a request open the large body is a 413`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()

            val notAsked = upload(alice, board, 1, byteArrayOf(1)).expectBody<ErrorModel>().returnResult()
            val notAskedAndLarge = upload(alice, board, 1, ByteArray(4096)).expectBody<ErrorModel>().returnResult()
            assertEquals(HttpStatus.CONFLICT, notAsked.status, "no open request")
            assertEquals(HttpStatus.CONFLICT, notAskedAndLarge.status, "the request is checked before the body is read, so 409 and not 413")
            assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, notAskedAndLarge.responseBody?.code, "error code")

            val editor = alice.open(board)
            editor.until(ServerFrame.SYNCED)
            repeat(4) { editor.send(update(it)) }
            val upToSeq = editor.until(ServerFrame.COMPACT).last().varUint()
            val tooLarge = upload(alice, board, upToSeq, ByteArray(4096)).expectBody<ErrorModel>().returnResult()
            assertEquals(413, tooLarge.status.value(), "above the limit")
            assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, tooLarge.responseBody?.code, "error code")
        }

        @Test
        fun `when a user starts more than ten snapshot uploads in a minute then 429 with Retry-After`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()

            val statuses = List(11) { upload(alice, board, 1, byteArrayOf(1)).expectBody<ErrorModel>().returnResult() }

            assertEquals(List(10) { HttpStatus.CONFLICT }, statuses.take(10).map { it.status }, "the first ten are answered")
            assertEquals(HttpStatus.TOO_MANY_REQUESTS, statuses.last().status, "the eleventh is limited")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, statuses.last().responseBody?.code, "error code")
            assertEquals(true, statuses.last().responseHeaders.getFirst("Retry-After") != null, "Retry-After")
        }

        @Test
        fun `when a stranger uploads a snapshot then 404`() = runBlocking {
            val board = User("Alice").createBoard()

            val result = upload(User("Bob"), board, 1, byteArrayOf(1)).expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "no role on the board")
        }
    }

    @Nested
    inner class Metrics {

        @Test
        fun `when sessions exchange updates then the sessions gauge and the update counters move`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val updatesBefore = meters.counter("drawboard.collab.updates").count()
            val bytesBefore = meters.summary("drawboard.collab.update.bytes").totalAmount()
            val socket = alice.open(board)
            socket.until(ServerFrame.SYNCED)

            socket.send(update(1, 2, 3))
            socket.until(ServerFrame.ACK)

            assertTrue(meters.get("drawboard.collab.sessions").gauge().value() >= 1.0, "open sessions")
            assertTrue(meters.get("drawboard.collab.rooms").gauge().value() >= 1.0, "open rooms")
            assertEquals(updatesBefore + 1, meters.counter("drawboard.collab.updates").count(), "one more update")
            val bytes = meters.summary("drawboard.collab.update.bytes").totalAmount()
            assertEquals(bytesBefore + 3, bytes, "bytes of the update, without the type byte")
        }
    }

    @Nested
    inner class Deletion {

        @Test
        fun `when the board is deleted then its open sessions are closed with 4404`() = runBlocking {
            val alice = User("Alice")
            val board = alice.createBoard()
            val socket = alice.open(board)
            socket.until(ServerFrame.SYNCED)

            alice.authed().delete().uri("/api/boards/${board.id}").exchange().expectBody<String>().returnResult()

            assertEquals(4404, socket.closeStatus().code, "board deleted")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun jwks(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
        }
    }
}
