package at.dergeorg.drawboard.collab.domain.rooms

import at.dergeorg.drawboard.collab.domain.storage.requires.UpdateLog
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineStart
import at.dergeorg.drawboard.collab.domain.FakeBoardAccess
import at.dergeorg.drawboard.collab.domain.Frame
import at.dergeorg.drawboard.collab.domain.InMemorySnapshotStore
import at.dergeorg.drawboard.collab.domain.InMemoryUpdateLog
import at.dergeorg.drawboard.collab.domain.RecordingBoardActivity
import at.dergeorg.drawboard.collab.domain.RecordingCollabMetrics
import at.dergeorg.drawboard.collab.domain.TestClient
import at.dergeorg.drawboard.collab.domain.protocol.hex
import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import at.dergeorg.drawboard.collab.domain.storage.model.StoredSnapshot
import at.dergeorg.drawboard.collab.domain.types
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.testing.FIXED_NOW
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAppLogger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

@OptIn(ExperimentalCoroutinesApi::class)
class RoomRegistryTest {

    private val clock = MutableClock()
    private val log = InMemoryUpdateLog()
    private val snapshots = InMemorySnapshotStore()
    private val access = FakeBoardAccess()
    private val activity = RecordingBoardActivity()
    private val logger = RecordingAppLogger()
    private val metrics = RecordingCollabMetrics()
    private val board = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f")
    private val alice = Uuid.random()
    private val bob = Uuid.random()
    private val carol = Uuid.random()

    private fun TestScope.registry(limits: CollabLimits = CollabLimits()) = RoomRegistry(
        log, snapshots, access, activity, limits, clock, logger,
        CoroutineScope(UnconfinedTestDispatcher(testScheduler) + SupervisorJob()), metrics,
    )

    private companion object {
        /** One awareness entry of clientID 42. */
        const val AWARENESS_42 = "012a01247b2275736572223a7b226e616d65223a2278227d2c22637572736f72223a5b312c325d7d"
    }

    private suspend fun RoomRegistry.join(
        user: Uuid,
        role: CollabRole = CollabRole.EDITOR,
        tokenExp: kotlin.time.Instant = FIXED_NOW + 1.hours,
    ): TestClient {
        access.roles[board to user] = role
        return TestClient(open(Admission.Admitted(board, user, "User ${user.toString().take(4)}", tokenExp, role)))
    }

    private suspend fun TestClient.send(vararg bytes: Int) = connection.onBinary(ByteArray(bytes.size) { bytes[it].toByte() })

    private suspend fun TestClient.sendUpdate(payload: String) = connection.onBinary(byteArrayOf(0x01) + hex(payload))

    private suspend fun TestClient.sendAwareness(payload: String) = connection.onBinary(byteArrayOf(0x02) + hex(payload))

    private fun List<Frame>.updateSeqs() = filter { it.type == Frame.UPDATE }.map { it.seqAndData.first }

    private fun updateEntry(seq: Long, payload: String = "aa") =
        LoggedUpdate(board, seq, hex(payload), alice, FIXED_NOW)

    @Nested
    inner class Join {

        @Test
        fun `when joining an empty board then WELCOME with role and limits comes first, then SYNCED with head 0`() = runTest {
            val registry = registry()

            val frames = registry.join(alice, CollabRole.OWNER).drain()

            assertEquals(listOf(Frame.WELCOME, Frame.SYNCED), frames.types(), "join frames of an empty board")
            val welcome = frames[0].text
            assertTrue(welcome.startsWith("""{"role":"OWNER","self":{"id":"$alice""""), "role and self: $welcome")
            assertTrue(welcome.endsWith(""""limits":{"update":1048576,"awareness":16384}}"""), "effective frame limits: $welcome")
            assertEquals(0, frames[1].number, "head sequence of an empty board")
        }

        @Test
        fun `when joining a board with a snapshot and log then SNAPSHOT and the later entries come in order`() = runTest {
            snapshots.insert(StoredSnapshot(board, upToSeq = 2, data = hex("5051"), createdBy = alice, createdAt = FIXED_NOW))
            log.entries += listOf(updateEntry(1), updateEntry(2), updateEntry(3, "bb"), updateEntry(4, "cc"))
            val registry = registry()

            val frames = registry.join(bob).drain()

            assertEquals(
                listOf(Frame.WELCOME, Frame.SNAPSHOT, Frame.UPDATE, Frame.UPDATE, Frame.SYNCED),
                frames.types(),
                "WELCOME, SNAPSHOT, UPDATE*, SYNCED",
            )
            assertEquals(2L, frames[1].seqAndData.first, "snapshot up to seq")
            assertContentEquals(hex("5051"), frames[1].seqAndData.second, "snapshot bytes")
            assertEquals(listOf(3L, 4L), frames.updateSeqs(), "entries after the snapshot only")
            assertEquals(4, frames.last().number, "head")
        }

        @Test
        fun `when an update arrives during another join then it follows the replay once, before SYNCED`() = runTest {
            log.entries += listOf(updateEntry(1), updateEntry(2))
            val registry = registry()
            val editor = registry.join(alice)
            editor.drain()
            val gate = CompletableDeferred<Unit>().also { log.gate = it }

            val joiner = registry.join(bob) // suspends in the log replay
            editor.sendUpdate("dd")
            gate.complete(Unit)

            val frames = joiner.drain()
            assertEquals(
                listOf(Frame.WELCOME, Frame.UPDATE, Frame.UPDATE, Frame.UPDATE, Frame.SYNCED),
                frames.types(),
                "replay (1, 2), the update that came meanwhile (3), SYNCED",
            )
            assertEquals(listOf(1L, 2L, 3L), frames.updateSeqs(), "ascending, no duplicates")
            assertEquals(3, frames.last().number, "SYNCED carries the head including the parked update")
        }

        @Test
        fun `when a session joins then the others get PEER_JOINED and when it leaves PEER_LEFT, both with the sender`() = runTest {
            val registry = registry()
            val alicesClient = registry.join(alice)
            alicesClient.drain()

            val bobsClient = registry.join(bob)
            val joined = alicesClient.drain().single()
            bobsClient.connection.disconnected()
            val left = alicesClient.drain().single()

            assertEquals(Frame.PEER_JOINED, joined.type, "joined")
            assertTrue(joined.text.contains(""""id":"$bob""""), "From names the joiner: ${joined.text}")
            assertEquals(Frame.PEER_LEFT, left.type, "left")
            assertEquals(joined.text, left.text, "same From")
        }

        @Test
        fun `when the last session leaves then the room is gone`() = runTest {
            val registry = registry()
            val client = registry.join(alice)

            client.connection.disconnected()
            client.connection.disconnected()

            assertEquals(0, registry.roomCount, "no room without sessions")
            assertEquals(0, registry.sessionCount, "no session")
        }
    }

    @Nested
    inner class Updates {

        @Test
        fun `when an editor sends an update then it is logged, acked to the sender and relayed to the others`() = runTest {
            val registry = registry()
            val editor = registry.join(alice)
            val viewer = registry.join(bob, CollabRole.VIEWER)
            editor.drain()
            viewer.drain()

            editor.sendUpdate("0102")
            editor.sendUpdate("0304")

            assertEquals(listOf(1L, 2L), log.entries.map { it.seq }, "no gaps, in order")
            assertEquals(alice, log.entries.first().authorId, "author")
            assertEquals(listOf(Frame.ACK, Frame.ACK), editor.drain().types().also { }, "the sender gets ACKs, not its own update")
            val relayed = viewer.drain()
            assertEquals(listOf(Frame.UPDATE, Frame.UPDATE), relayed.types(), "the other session gets the updates")
            assertEquals(1L, relayed[0].seqAndData.first, "seq")
            assertContentEquals(hex("0102"), relayed[0].seqAndData.second, "bytes")
        }

        @Test
        fun `when a viewer or commenter sends an update then it is dropped and the tenth closes the session with 4403`() = runTest {
            val registry = registry()
            val viewer = registry.join(bob, CollabRole.VIEWER)
            val commenter = registry.join(carol, CollabRole.COMMENTER)
            viewer.drain()
            commenter.drain()

            repeat(9) { viewer.sendUpdate("01") }
            commenter.sendUpdate("01")

            assertTrue(log.entries.isEmpty(), "nothing appended")
            assertNull(viewer.closeOrder, "nine violations are tolerated")
            viewer.sendUpdate("01")
            assertEquals(4403, viewer.closeOrder?.code, "tenth violation")
            assertNull(commenter.closeOrder, "one violation of another session")
        }

        @Test
        fun `when an update is larger than the limit then the session is closed with 1009 and nothing is stored`() = runTest {
            val registry = registry(CollabLimits(maxUpdateBytes = 4))
            val editor = registry.join(alice)

            editor.sendUpdate("0102030405")

            assertEquals(1009, editor.closeOrder?.code, "too large")
            assertTrue(log.entries.isEmpty(), "not stored")
        }

        @Test
        fun `when a session sends more than its burst of updates then it is closed with 4429`() = runTest {
            val registry = registry(CollabLimits(updateBurst = 3, updatesPerSecond = 1))
            val editor = registry.join(alice)

            repeat(3) { editor.sendUpdate("01") }
            assertNull(editor.closeOrder, "within the burst")
            editor.sendUpdate("01")

            assertEquals(4429, editor.closeOrder?.code, "above the burst")
            assertEquals(3, log.entries.size, "the excess update is not stored")
        }

        @Test
        fun `when the log would exceed the board limit then the update is rejected and the sender closed with 4413`() = runTest {
            val registry = registry(CollabLimits(maxLogBytes = 5))
            val editor = registry.join(alice)
            val other = registry.join(bob)

            editor.sendUpdate("010203")
            editor.sendUpdate("040506")

            assertEquals(1, log.entries.size, "second update rejected")
            assertEquals(4413, editor.closeOrder?.code, "board is full")
            assertNull(other.closeOrder, "readers stay")
        }

        @Test
        fun `when a client cannot keep up and its buffer is full then it is closed with 1011`() = runTest {
            val registry = registry(CollabLimits(outboundBuffer = 4))
            val editor = registry.join(alice)
            val slow = registry.join(bob) // WELCOME and SYNCED are queued, the client reads nothing
            editor.drain()

            repeat(3) { editor.sendUpdate("01") }

            assertEquals(1011, slow.closeOrder?.code, "slow consumer")
            assertNull(editor.closeOrder, "the sender is fine")
        }

        @Test
        fun `when snapshots are kept then they do not count toward the log limit`() = runTest {
            snapshots.insert(StoredSnapshot(board, 0, hex("01020304"), alice, FIXED_NOW))
            val registry = registry(CollabLimits(maxLogBytes = 8))
            val editor = registry.join(alice)

            editor.sendUpdate("0102030405") // 4 bytes snapshot, 5 bytes log: only the 5 count
            assertNull(editor.closeOrder, "the snapshots have a budget of their own")
            assertEquals(1, log.entries.size, "appended")
        }

        @Test
        fun `when a client has more bytes queued than allowed then it is closed with 1011 and one that reads is not`() = runTest {
            val registry = registry(CollabLimits(outboundBytes = 2_000))
            val editor = registry.join(alice)
            val slow = registry.join(bob)
            val reading = registry.join(carol)
            editor.drain()
            slow.drain()
            reading.drain()

            repeat(2) {
                editor.sendUpdate("aa".repeat(1_000))
                reading.drain()
            }

            assertEquals(1011, slow.closeOrder?.code, "two 1000-byte frames do not fit 2000 bytes together with the first one")
            assertNull(reading.closeOrder, "it takes its frames, the bytes are given back")
            assertNull(editor.closeOrder, "the sender is fine")
        }

        @Test
        fun `when an accepted update comes then the activity is reported at most once per minute`() = runTest {
            val registry = registry()
            val editor = registry.join(alice)

            editor.sendUpdate("01")
            editor.sendUpdate("02")
            clock.advanceBy(61.seconds)
            editor.sendUpdate("03")

            assertEquals(2, activity.changes.size, "first update and the one after a minute")
            assertEquals(board, activity.changes.first().first, "board")
        }
    }

    @Nested
    inner class Messages {

        private val oneEntry = "012a01247b2275736572223a7b226e616d65223a2278227d2c22637572736f72223a5b312c325d7d" // clientID 42
        private val otherEntry = "012b02046e756c6c" // clientID 43, state null
        private val twoEntries = "020701077b2261223a317dac0201077b2262223a327d"

        @Test
        fun `when a client sends PING then it gets PONG`() = runTest {
            val client = registry().join(alice)
            client.drain()

            client.send(0x03)

            assertEquals(listOf(Frame.PONG), client.drain().types(), "PONG")
        }

        @Test
        fun `when a client sends awareness then the others get it wrapped with the sender, and the sender binds its client id`() = runTest {
            val registry = registry()
            val sender = registry.join(alice)
            val receiver = registry.join(bob, CollabRole.VIEWER)
            sender.drain()
            receiver.drain()

            sender.sendAwareness(oneEntry)

            assertTrue(sender.drain().isEmpty(), "not echoed to the sender")
            val frame = receiver.drain().single()
            val (from, payload) = frame.fromAndPayload
            assertEquals(Frame.AWARENESS, frame.type, "type")
            val name = "User ${alice.toString().take(4)}"
            assertTrue(from.startsWith("""{"id":"$alice","name":"$name","guest":false,"color":"#"""), "From from the principal: $from")
            assertTrue(from.endsWith(""","role":"EDITOR","clientId":42}"""), "From carries the role and the bound client id: $from")
            assertContentEquals(hex(oneEntry), payload, "payload as sent")
        }

        @Test
        fun `when awareness has two entries or another client id than the bound one then it is dropped without closing`() = runTest {
            val registry = registry()
            val sender = registry.join(alice)
            val receiver = registry.join(bob)
            sender.drain()
            receiver.drain()

            sender.sendAwareness(twoEntries)
            sender.sendAwareness(oneEntry)
            sender.sendAwareness(otherEntry) // foreign client id after 42 is bound

            assertEquals(1, receiver.drain().size, "only the first valid frame is relayed")
            assertNull(sender.closeOrder, "dropped, not closed")
        }

        @Test
        fun `when a session claims the client id another session already uses then the frame is dropped`() = runTest {
            val registry = registry()
            val first = registry.join(alice)
            val thief = registry.join(bob)
            val watcher = registry.join(carol)
            first.sendAwareness(oneEntry)
            listOf(first, thief, watcher).forEach { it.drain() }

            thief.sendAwareness(oneEntry)

            assertTrue(watcher.drain().isEmpty(), "client id 42 belongs to the first session")
        }

        @Test
        fun `when an awareness frame is malformed or too large then the session is closed`() = runTest {
            val registry = registry(CollabLimits(maxAwarenessBytes = 20))
            val broken = registry.join(alice)
            val big = registry.join(bob)

            broken.sendAwareness("012a0103787878") // state is not JSON
            big.sendAwareness(oneEntry) // 38 bytes

            assertEquals(4400, broken.closeOrder?.code, "malformed")
            assertEquals(1009, big.closeOrder?.code, "above the awareness limit")
        }

        @Test
        fun `when a client sends a text frame an unknown type or garbage then the session is closed with 4400`() = runTest {
            val registry = registry()
            val text = registry.join(alice)
            val unknown = registry.join(bob)
            val empty = registry.join(carol)

            text.connection.onText()
            unknown.send(0x7f)
            empty.connection.onBinary(ByteArray(0))

            assertEquals(listOf(4400, 4400, 4400), listOf(text, unknown, empty).map { it.closeOrder?.code }, "protocol violations")
        }
    }

    @Nested
    inner class Sweep {

        @Test
        fun `when the token behind the ticket expires then the session is closed with 4401`() = runTest {
            val registry = registry(CollabLimits(idleTimeoutSeconds = 3600))
            val client = registry.join(alice, tokenExp = FIXED_NOW + 10.minutes)

            clock.advanceBy(9.minutes)
            registry.sweep()
            assertNull(client.closeOrder, "token still valid")
            clock.advanceBy(1.minutes)
            registry.sweep()

            assertEquals(4401, client.closeOrder?.code, "token expired")
        }

        @Test
        fun `when a session sent nothing for five minutes then it is closed with 4408 and a ping keeps it alive`() = runTest {
            val registry = registry()
            val idle = registry.join(alice)
            val alive = registry.join(bob)

            clock.advanceBy(4.minutes)
            alive.send(0x03)
            clock.advanceBy(61.seconds)
            registry.sweep()

            assertEquals(4408, idle.closeOrder?.code, "idle for 5 minutes and 1 second")
            assertNull(alive.closeOrder, "pinged a minute ago")
        }

        @Test
        fun `when the role changed or is gone at the minutely re-check then ROLE is sent or the session is closed with 4403`() = runTest {
            val registry = registry()
            val demoted = registry.join(alice, CollabRole.EDITOR)
            val removed = registry.join(bob, CollabRole.EDITOR)
            val unchanged = registry.join(carol, CollabRole.EDITOR)
            listOf(demoted, removed, unchanged).forEach { it.drain() }
            access.roles[board to alice] = CollabRole.VIEWER
            access.roles.remove(board to bob)

            clock.advanceBy(61.seconds)
            registry.sweep()

            val role = demoted.drain().filter { it.type == Frame.ROLE }.single()
            assertEquals(Frame.ROLE, role.type, "ROLE frame")
            assertEquals("""{"role":"VIEWER"}""", role.text, "new role")
            assertEquals(4403, removed.closeOrder?.code, "access lost")
            assertTrue(unchanged.drain().none { it.type == Frame.ROLE }, "no ROLE frame for an unchanged role")

            demoted.sendUpdate("01")
            assertTrue(log.entries.isEmpty(), "the demoted editor's updates are dropped from now on")
        }

        @Test
        fun `when the role changes at the re-check then the sender's From names the new role`() = runTest {
            val registry = registry()
            val demoted = registry.join(alice, CollabRole.EDITOR)
            val receiver = registry.join(bob, CollabRole.VIEWER)
            demoted.sendAwareness(AWARENESS_42)
            val before = receiver.drain().single { it.type == Frame.AWARENESS }.fromAndPayload.first
            access.roles[board to alice] = CollabRole.VIEWER

            clock.advanceBy(61.seconds)
            registry.sweep()
            demoted.sendAwareness(AWARENESS_42)

            val after = receiver.drain().single { it.type == Frame.AWARENESS }.fromAndPayload.first
            assertTrue(before.contains(""""role":"EDITOR""""), "editor before: $before")
            assertTrue(after.contains(""""role":"VIEWER""""), "viewer after the re-check: $after")
            assertTrue(after.endsWith(""","clientId":42}"""), "the bound client id stays: $after")
        }

        @Test
        fun `when the role check fails then the sessions stay open`() = runTest {
            val registry = registry()
            val client = registry.join(alice)
            access.failing = true

            clock.advanceBy(61.seconds)
            registry.sweep()

            assertNull(client.closeOrder, "a failing check is no reason to close")
            assertTrue(logger.entries.any { it.message == "collab role check failed" }, "but it is logged")
        }
    }

    @Nested
    inner class Limits {

        @Test
        fun `when a user has the maximum of sessions then the next is closed with 4429, visible before the upgrade`() = runTest {
            val registry = registry(CollabLimits(maxSessionsPerUser = 2))
            registry.join(alice)
            registry.join(alice)

            val third = registry.join(alice)

            assertEquals(4429, third.closeOrder?.code, "session limit")
            assertTrue(registry.sessionLimitReached(board, alice), "handshake would answer 429")
            assertEquals(2, registry.sessionCount, "the rejected one is not registered")
        }

        @Test
        fun `when guests rotate addresses inside one IPv6 64 bit prefix then they share the cap, another prefix does not`() = runTest {
            val registry = registry(CollabLimits(maxGuestSessionsPerIp = 2))
            suspend fun guest(address: String): TestClient {
                val id = Uuid.random()
                access.roles[board to id] = CollabRole.VIEWER
                val admitted = Admission.Admitted(
                    board, id, "Guest", FIXED_NOW + 1.hours, CollabRole.VIEWER, shareId = Uuid.random(), clientAddress = address,
                )
                return TestClient(registry.open(admitted))
            }
            guest("2001:db8:1:2:0:0:0:1")
            guest("2001:db8:1:2:aaaa:0:0:2")

            val third = guest("2001:db8:1:2:bbbb:0:0:3")
            val elsewhere = guest("2001:db8:1:3:0:0:0:1")

            assertEquals(4429, third.closeOrder?.code, "a third address of the same /64 hits the cap")
            assertTrue(registry.sessionLimitReached(board, alice, "2001:db8:1:2:cccc:0:0:4"), "the handshake would answer 429")
            assertEquals(null, elsewhere.closeOrder, "another /64 is another client")
        }

        @Test
        fun `when a board already has the maximum of sessions then another user is refused too`() = runTest {
            val registry = registry(CollabLimits(maxSessionsPerBoard = 2))
            registry.join(alice)
            registry.join(bob)

            assertEquals(4429, registry.join(carol).closeOrder?.code, "board limit")
        }
    }

    @Nested
    inner class Compaction {

        private val limits = CollabLimits(compactionEntries = 3, compactionMinIntervalSeconds = 0)

        @Test
        fun `when the log since the snapshot has too many entries then one editor is asked with the head seq, once`() = runTest {
            val registry = registry(limits)
            val editor = registry.join(alice)
            val viewer = registry.join(bob, CollabRole.VIEWER)
            editor.drain()
            viewer.drain()

            repeat(5) { editor.sendUpdate("01") }

            val compacts = editor.drain().filter { it.type == Frame.COMPACT }
            assertEquals(listOf(4L), compacts.map { it.number }, "asked once, at the first update past the limit")
            assertTrue(viewer.drain().none { it.type == Frame.COMPACT }, "a viewer is never asked")
        }

        @Test
        fun `when nobody is eligible then no request is made, and when the request expires another editor is asked`() = runTest {
            val registry = registry(limits)
            val first = registry.join(alice)
            val second = registry.join(bob)
            first.drain()
            second.drain()
            repeat(4) { first.sendUpdate("01") }
            assertEquals(1, first.drain().count { it.type == Frame.COMPACT }, "first request goes to the sender")

            clock.advanceBy(121.seconds)
            registry.sweep()

            assertEquals(1, second.drain().count { it.type == Frame.COMPACT }, "after two minutes the other editor is asked")
        }

        @Test
        fun `when the asked user answers for exactly the requested seq then the request is consumed, else 409`() = runTest {
            val registry = registry(limits)
            val editor = registry.join(alice)
            repeat(4) { editor.sendUpdate("01") }

            assertFailsWith<DomainException>("wrong seq") { registry.takeCompactionRequest(board, alice, 3) }
                .also { assertEquals(ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED, it.errorCode, "code") }
            assertFailsWith<DomainException>("wrong user") { registry.takeCompactionRequest(board, bob, 4) }
            registry.takeCompactionRequest(board, alice, 4)
            assertFailsWith<DomainException>("a request is good for one upload") { registry.takeCompactionRequest(board, alice, 4) }
        }

        @Test
        fun `when the request is older than two minutes then answering it is a 409`() = runTest {
            val registry = registry(limits)
            val editor = registry.join(alice)
            repeat(4) { editor.sendUpdate("01") }

            clock.advanceBy(121.seconds)

            assertFailsWith<DomainException>("expired") { registry.takeCompactionRequest(board, alice, 4) }
        }

        @Test
        fun `when a snapshot is stored then the counters start again and the next request waits for new entries`() = runTest {
            val registry = registry(limits)
            val editor = registry.join(alice)
            repeat(4) { editor.sendUpdate("01") }
            editor.drain()
            registry.takeCompactionRequest(board, alice, 4)
            log.deleteUpTo(board, 4) // what the service does with the retention plan

            registry.snapshotStored(board, 4)
            repeat(3) { editor.sendUpdate("01") }

            assertTrue(editor.drain().none { it.type == Frame.COMPACT }, "3 entries since the snapshot are not more than 3")
            editor.sendUpdate("01")
            assertEquals(1, editor.drain().count { it.type == Frame.COMPACT }, "the 4th is")
        }
    }

    @Nested
    inner class CompactionInterval {

        private val limits = CollabLimits(compactionEntries = 3) // minimum interval: 60 seconds

        @Test
        fun `when a compaction was requested then the next one waits for the minimum interval, even if the log grew again`() = runTest {
            val registry = registry(limits)
            val editor = registry.join(alice)
            repeat(4) { editor.sendUpdate("01") }
            assertEquals(1, editor.drain().count { it.type == Frame.COMPACT }, "first request")
            registry.takeCompactionRequest(board, alice, 4)
            log.deleteUpTo(board, 4)
            registry.snapshotStored(board, 4)

            repeat(5) { editor.sendUpdate("01") }
            assertTrue(editor.drain().none { it.type == Frame.COMPACT }, "log is due again but 60 seconds have not passed")
            clock.advanceBy(30.seconds)
            registry.sweep()
            assertTrue(editor.drain().none { it.type == Frame.COMPACT }, "30 seconds are not enough")

            clock.advanceBy(31.seconds)
            registry.sweep()

            assertEquals(1, editor.drain().count { it.type == Frame.COMPACT }, "after 61 seconds the sweep asks")
        }
    }

    @Nested
    inner class Rooms {

        @Test
        fun `when an append is in flight while a document is replaced then the replace waits for it and nothing lands after`() = runTest {
            val gate = CompletableDeferred<Unit>()
            val gated = object : UpdateLog by log {
                override suspend fun append(update: LoggedUpdate) {
                    gate.await() // the database write is "slow"
                    log.append(update)
                }
            }
            val registry = RoomRegistry(
                gated, snapshots, access, activity, CollabLimits(), clock, logger,
                CoroutineScope(UnconfinedTestDispatcher(testScheduler) + SupervisorJob()), metrics,
            )
            val editor = registry.join(alice)
            val sending = launch(start = CoroutineStart.UNDISPATCHED) { editor.send(0x01, 1, 2) }
            val replacing = launch(start = CoroutineStart.UNDISPATCHED) { registry.beginReplace(board) }

            assertTrue(replacing.isActive, "the replace waits for the append that already passed the closed check")
            assertEquals(null, editor.closeOrder, "the session is still open meanwhile")
            gate.complete(Unit)
            sending.join()
            replacing.join()

            assertEquals(4410, editor.closeOrder?.code, "then the session is closed")
            assertEquals(1L, log.lastSeq(board), "the in-flight update was written BEFORE the restore starts")
            editor.send(0x01, 3, 4)
            assertEquals(1L, log.lastSeq(board), "an update after the close is dropped, not appended")
        }

        @Test
        fun `when a room is opened after a restart then the head continues after the log and the snapshot`() = runTest {
            snapshots.insert(StoredSnapshot(board, upToSeq = 7, data = hex("50"), createdBy = alice, createdAt = FIXED_NOW))
            log.entries += listOf(updateEntry(8), updateEntry(9))
            val registry = registry()
            val editor = registry.join(alice)
            editor.drain()

            editor.sendUpdate("01")

            assertEquals(10, log.entries.maxOf { it.seq }, "next seq")
            assertEquals(Frame.ACK, editor.drain().single().type, "ack")
        }

        @Test
        fun `when the board is deleted then the room closes all sessions with 4404`() = runTest {
            val registry = registry()
            val clients = listOf(registry.join(alice), registry.join(bob))

            registry.closeRoom(board, 4404, "board deleted")

            assertEquals(listOf(4404, 4404), clients.map { it.closeOrder?.code }, "close code of a deleted board")
            assertEquals(0, registry.roomCount, "room gone")
            assertNotNull(clients[0].closeOrder?.reason, "with a reason")
        }
    }

    @Nested
    inner class Metrics {

        @Test
        fun `when updates are accepted or dropped then they are counted with their bytes and the reason`() = runTest {
            val registry = registry()
            val editor = registry.join(alice)
            val viewer = registry.join(bob, CollabRole.VIEWER)

            editor.sendUpdate("010203")
            editor.sendUpdate("04")
            viewer.sendUpdate("05")
            viewer.sendAwareness("00")

            assertEquals(listOf(3, 1), metrics.updates, "accepted updates, by size")
            assertEquals(listOf(DropReason.ROLE, DropReason.AWARENESS), metrics.drops, "viewer update, awareness without exactly one entry")
        }

        @Test
        fun `when sessions end then each close is counted once with its code, a client that left as client`() = runTest {
            val registry = registry(CollabLimits(maxUpdateBytes = 2))
            val tooBig = registry.join(alice)
            val leaver = registry.join(bob)

            tooBig.sendUpdate("010203")
            tooBig.connection.disconnected()
            leaver.connection.disconnected()

            assertEquals(listOf("1009", "client"), metrics.closes, "server-ordered close with its code; the client that left by itself")
        }

        @Test
        fun `when the compaction runs its course then requested, rejected, stored and expired are counted`() = runTest {
            val registry = registry(CollabLimits(compactionEntries = 1, compactionMinIntervalSeconds = 0))
            val editor = registry.join(alice)
            repeat(2) { editor.sendUpdate("01") }
            runCatching { registry.takeCompactionRequest(board, bob, 2) }
            registry.takeCompactionRequest(board, alice, 2)
            registry.snapshotStored(board, 2)
            repeat(2) { editor.sendUpdate("01") }
            clock.advanceBy(121.seconds)
            registry.sweep()

            val requested = CompactionResult.REQUESTED
            assertEquals(
                listOf(requested, CompactionResult.REJECTED, CompactionResult.STORED, requested, CompactionResult.EXPIRED, requested),
                metrics.compactions,
                "requested at the second update; a stranger's answer rejected; stored; asked again; expired unanswered and asked again",
            )
        }
    }
}
