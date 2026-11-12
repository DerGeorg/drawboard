package at.dergeorg.drawboard.collab.domain.rooms

import at.dergeorg.drawboard.collab.domain.protocol.AwarenessPayload
import at.dergeorg.drawboard.collab.domain.protocol.ClientFrame
import at.dergeorg.drawboard.collab.domain.protocol.PeerJson
import at.dergeorg.drawboard.collab.domain.protocol.ProtocolViolation
import at.dergeorg.drawboard.collab.domain.protocol.ServerFrames
import at.dergeorg.drawboard.collab.domain.rooms.model.Admission
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabConnection
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardAccess
import at.dergeorg.drawboard.collab.domain.rooms.requires.BoardActivity
import at.dergeorg.drawboard.collab.domain.storage.model.LoggedUpdate
import at.dergeorg.drawboard.collab.domain.storage.requires.SnapshotStore
import at.dergeorg.drawboard.collab.domain.storage.requires.UpdateLog
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.security.IpBuckets
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole

/**
 * The rooms of all open boards and everything that happens in them: join, relay, roles, limits, compaction requests,
 * idle and expiry. Pure logic on top of ports and a clock - no Spring, no WebSocket - so the tests drive it with
 * fakes. [scope] runs the joins and the closing clean-up; it is the application's own scope, not a request's.
 *
 * Close codes are those of docs/collab-protocol.md (API repository).
 */
internal class RoomRegistry(
    private val log: UpdateLog,
    private val snapshots: SnapshotStore,
    private val access: BoardAccess,
    private val activity: BoardActivity,
    private val limits: CollabLimits,
    private val clock: Clock,
    private val logger: AppLogger,
    private val scope: CoroutineScope,
    private val metrics: CollabMetrics,
) {
    private val rooms = ConcurrentHashMap<Uuid, Room>()

    /** Adding and removing sessions and rooms; reading a room's state from the database happens under it, too. */
    private val registryLock = Mutex()

    @Volatile
    private var lastAclCheck: Instant = clock.now()

    val sessionCount: Int get() = rooms.values.sumOf { it.sessions.size }

    val roomCount: Int get() = rooms.size

    /** Best effort before the upgrade; [open] checks again under the lock. */
    fun sessionLimitReached(boardId: Uuid, userId: Uuid, guestAddress: String? = null): Boolean =
        (rooms[boardId]?.sessions?.size ?: 0) >= limits.maxSessionsPerBoard || sessionsOf(userId) >= limits.maxSessionsPerUser ||
            (guestAddress != null && guestSessionsFrom(guestAddress) >= limits.maxGuestSessionsPerIp)

    /** Guest sessions of one client: counted per IPv6 /64 (IPv4: the address), so rotating inside a /64 buys nothing (S2.5, S7.3). */
    private fun guestSessionsFrom(address: String): Int {
        val bucket = IpBuckets.of(address)
        return rooms.values.sumOf { room -> room.sessions.values.count { it.clientAddress?.let(IpBuckets::of) == bucket } }
    }

    private fun sessionsOf(userId: Uuid) = rooms.values.sumOf { room -> room.sessions.values.count { it.userId == userId } }

    // ---------------------------------------------------------------------------------------------- open and join

    /** Boards whose document is being replaced (version restore): nobody may join, and every session is closed. */
    private val replacing = ConcurrentHashMap.newKeySet<Uuid>()

    fun isReplacing(boardId: Uuid): Boolean = boardId in replacing

    /** Marks the board and closes every session with 4410, in this order, so no join slips in between. */
    suspend fun beginReplace(boardId: Uuid) {
        registryLock.withLock { replacing += boardId }
        val room = rooms[boardId] ?: return
        // An update appends to the log INSIDE the room's mutex. Taking it here waits for an append that is in flight and
        // lets every later one see a closed session - so nothing lands in the log once the restore starts.
        room.mutex.withLock { closeRoom(boardId, CLOSE_REPLACED, "document replaced") }
    }

    fun endReplace(boardId: Uuid) {
        replacing -= boardId
    }

    suspend fun open(admitted: Admission.Admitted): CollabConnection {
        val session = Session(
            id = Uuid.generateV7(),
            boardId = admitted.boardId,
            userId = admitted.userId,
            displayName = admitted.displayName,
            tokenExpiresAt = admitted.tokenExpiresAt,
            role = admitted.role,
            participant = admitted.participant,
            clientAddress = admitted.clientAddress,
            limits = limits,
            now = clock.now(),
        )
        val room = registryLock.withLock {
            if (admitted.boardId in replacing || sessionLimitReached(admitted.boardId, admitted.userId, admitted.clientAddress)) {
                null
            } else {
                (rooms[admitted.boardId] ?: loadRoom(admitted.boardId).also { rooms[admitted.boardId] = it })
                    .also { it.sessions[session.id] = session }
            }
        }
        if (room == null) {
            val code = if (admitted.boardId in replacing) CLOSE_REPLACED else CLOSE_RATE_LIMIT
            session.markClosed(code, if (code == CLOSE_REPLACED) "document replaced" else "too many sessions")
            metrics.closed(code.toString())
        } else {
            scope.launch { join(room, session) }
        }
        return SessionConnection(session, this)
    }

    private suspend fun loadRoom(boardId: Uuid): Room {
        val metas = snapshots.listMeta(boardId)
        val snapshotUpTo = metas.firstOrNull()?.upToSeq ?: 0
        val lastSeq = log.lastSeq(boardId) ?: 0
        return Room(
            boardId = boardId,
            headSeq = maxOf(snapshotUpTo, lastSeq),
            snapshotUpToSeq = snapshotUpTo,
            logBytes = log.sizeAfter(boardId, 0),
            sinceSnapshotBytes = log.sizeAfter(boardId, snapshotUpTo),
            sinceSnapshotEntries = log.countAfter(boardId, snapshotUpTo),
        )
    }

    /**
     * WELCOME, SNAPSHOT, UPDATE*, SYNCED. The log is replayed WITHOUT the room's lock (a slow client must not stall
     * the board); what other sessions send meanwhile is parked in [Session.pending] and follows before SYNCED.
     */
    private suspend fun join(room: Room, session: Session) {
        try {
            val headAtJoin = room.mutex.withLock { room.headSeq.also { session.pending.clear(); session.pendingBytes = 0 } }
            val welcome = PeerJson.welcome(session.role.name, session.from, limits.maxUpdateBytes, limits.maxAwarenessBytes)
            push(session, ServerFrames.welcome(welcome))
            val snapshot = snapshots.findLatest(room.boardId)
            if (snapshot != null) push(session, ServerFrames.snapshot(snapshot.upToSeq, snapshot.data))
            log.readAfter(room.boardId, snapshot?.upToSeq ?: 0)
                .takeWhile { it.seq <= headAtJoin }
                .collect { push(session, ServerFrames.update(it.seq, it.data)) }
            room.mutex.withLock { goLive(room, session) }
        } catch (_: JoinAborted) {
            // the session was closed meanwhile, nothing left to do
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            logger.error("collab join failed", e, LOG_BOARD to room.boardId.toString())
            terminate(session, CLOSE_SERVER_ERROR, "server error")
        }
    }

    /** Room lock held. Flushes what was parked during the replay, then SYNCED, then tells the others. */
    private fun goLive(room: Room, session: Session) {
        if (session.isClosed) return
        for (frame in session.pending) {
            if (!session.offer(frame)) return terminate(session, CLOSE_SERVER_ERROR, "client too slow")
        }
        session.pending.clear()
        session.pendingBytes = 0
        session.live = true
        session.offer(ServerFrames.synced(room.headSeq))
        broadcast(room, except = session, frame = ServerFrames.peerJoined(session.from))
    }

    private class JoinAborted : RuntimeException()

    /** Sends during the join; waits for room in the buffer, but not forever. */
    private suspend fun push(session: Session, frame: ByteArray) {
        val sent = try {
            withTimeoutOrNull(limits.joinSendTimeoutSeconds.seconds) {
                session.send(frame)
                true
            }
        } catch (_: ClosedSendChannelException) {
            throw JoinAborted()
        }
        if (sent == null) {
            terminate(session, CLOSE_SERVER_ERROR, "client too slow")
            throw JoinAborted()
        }
    }

    // ------------------------------------------------------------------------------------------------- receiving

    suspend fun rejectText(session: Session) {
        terminate(session, CLOSE_PROTOCOL, "text frames are not part of drawboard.v1")
    }

    suspend fun receive(session: Session, frame: ByteArray) {
        if (session.isClosed) return
        val now = clock.now()
        session.lastActivity = now
        try {
            when (val decoded = ClientFrame.decode(frame)) {
                ClientFrame.Ping -> session.offer(ServerFrames.pong())
                is ClientFrame.Update -> onUpdate(session, decoded.bytes, now)
                is ClientFrame.Awareness -> onAwareness(session, decoded.bytes, now)
            }
        } catch (_: ProtocolViolation) {
            terminate(session, CLOSE_PROTOCOL, "protocol violation")
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            logger.error("collab frame failed", e, LOG_BOARD to session.boardId.toString())
            terminate(session, CLOSE_SERVER_ERROR, "server error")
        }
    }

    private suspend fun onUpdate(session: Session, data: ByteArray, now: Instant) {
        if (!session.role.canEdit) {
            // S2.4: dropped, counted; ten of them close the session
            session.violations++
            metrics.dropped(DropReason.ROLE)
            if (session.violations >= limits.violationsBeforeClose) terminate(session, CLOSE_FORBIDDEN, "not allowed to edit")
            return
        }
        if (data.size > limits.maxUpdateBytes) return terminate(session, CLOSE_TOO_BIG, "update too large")
        if (!session.updateBucket.tryTake(now)) return terminate(session, CLOSE_RATE_LIMIT, "too many updates")
        val room = rooms[session.boardId] ?: return
        var report = false
        room.mutex.withLock {
            if (session.isClosed) return
            if (room.logBytes + data.size > limits.maxLogBytes) {
                return terminate(session, CLOSE_BOARD_FULL, "board is full")
            }
            val seq = room.headSeq + 1
            log.append(LoggedUpdate(room.boardId, seq, data, session.userId, now))
            room.headSeq = seq
            room.logBytes += data.size
            room.sinceSnapshotBytes += data.size
            room.sinceSnapshotEntries++
            metrics.updateAccepted(data.size)
            deliver(session, ServerFrames.ack(seq))
            broadcast(room, except = session, frame = ServerFrames.update(seq, data))
            requestCompactionIfDue(room, now, preferred = session)
            if (now - room.lastActivityReport >= limits.activityThrottleSeconds.seconds) {
                room.lastActivityReport = now
                report = true
            }
        }
        if (report) reportActivity(room.boardId, now)
    }

    private suspend fun reportActivity(boardId: Uuid, at: Instant) {
        try {
            activity.contentChanged(boardId, at)
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            logger.warn("collab activity report failed", LOG_BOARD to boardId.toString(), "error.type" to e.javaClass.simpleName)
        }
    }

    private suspend fun onAwareness(session: Session, payload: ByteArray, now: Instant) {
        if (payload.size > limits.maxAwarenessBytes) return terminate(session, CLOSE_TOO_BIG, "awareness too large")
        if (!session.awarenessBucket.tryTake(now)) return terminate(session, CLOSE_RATE_LIMIT, "too much awareness")
        val entry = AwarenessPayload.parse(payload) // null: not exactly one entry
        val room = rooms[session.boardId] ?: return
        if (entry == null || !ownsClientId(room, session, entry.clientId)) {
            metrics.dropped(DropReason.AWARENESS)
            return
        }
        room.mutex.withLock {
            if (!session.isClosed) broadcast(room, except = session, frame = ServerFrames.awareness(session.from, payload))
        }
    }

    /**
     * S2.6: a session speaks with exactly one Yjs clientID. The first awareness frame binds it - unless another session
     * of the room already uses that id (it could then overwrite the other's cursor); later frames must keep it.
     */
    private fun ownsClientId(room: Room, session: Session, clientId: Long): Boolean {
        val bound = session.clientId
        if (bound != null) return bound == clientId
        if (room.sessions.values.any { it !== session && it.clientId == clientId }) return false
        session.bindClientId(clientId)
        return true
    }

    // ------------------------------------------------------------------------------------------------- relaying

    /** Room lock held. Queues [frame] for [session]; a session that cannot keep up is closed (1011). */
    private fun deliver(session: Session, frame: ByteArray) {
        if (session.isClosed) return
        if (!session.live) {
            if (session.pending.size >= limits.outboundBuffer || session.pendingBytes + frame.size > limits.outboundBytes) {
                terminate(session, CLOSE_SERVER_ERROR, "client too slow")
            } else {
                session.pending.add(frame)
                session.pendingBytes += frame.size
            }
        } else if (!session.offer(frame)) {
            terminate(session, CLOSE_SERVER_ERROR, "client too slow")
        }
    }

    private fun broadcast(room: Room, except: Session?, frame: ByteArray) {
        for (other in room.sessions.values) if (other !== except) deliver(other, frame)
    }

    // ------------------------------------------------------------------------------------------------ compaction

    /** Room lock held. S2.8: one open request per board, to a signed-in editor, when the log has grown enough. */
    private fun requestCompactionIfDue(room: Room, now: Instant, preferred: Session?) {
        val open = room.compaction
        if (open != null && now < open.expiresAt) return
        if (open != null) metrics.compaction(CompactionResult.EXPIRED)
        room.compaction = null
        val due = room.sinceSnapshotBytes > limits.compactionBytes || room.sinceSnapshotEntries > limits.compactionEntries
        val pause = now - room.lastCompactionAt < limits.compactionMinIntervalSeconds.seconds // not again right away
        if (!due || pause) return
        val candidates = listOfNotNull(preferred) + room.sessions.values.filter { it !== preferred }
        val eligible = candidates.filter { it.live && !it.isClosed && it.role.canEdit && !it.participant.guest } // never a guest (S2.8)
        val target = eligible.firstOrNull { it.id != room.lastCompactionTarget } ?: eligible.firstOrNull() ?: return
        room.compaction = CompactionRequest(
            sessionId = target.id,
            userId = target.userId,
            upToSeq = room.headSeq,
            expiresAt = now + limits.compactionRequestSeconds.seconds,
        )
        room.lastCompactionTarget = target.id
        room.lastCompactionAt = now
        metrics.compaction(CompactionResult.REQUESTED)
        deliver(target, ServerFrames.compact(room.headSeq))
    }

    /**
     * Consumes the open request: the user must be the one the server asked, for exactly [upToSeq], within the
     * request's time - otherwise `COLLAB_SNAPSHOT_NOT_REQUESTED` (409). A request is good for one upload.
     */
    suspend fun takeCompactionRequest(boardId: Uuid, userId: Uuid, upToSeq: Long) {
        val room = rooms[boardId]
        val valid = room?.mutex?.withLock {
            val matches = isOpenRequest(room, userId, upToSeq)
            if (matches) room.compaction = null
            matches
        } ?: false
        if (!valid) throw notRequested(boardId, upToSeq)
    }

    /**
     * Like [takeCompactionRequest], but the request stays open: the check before the upload body is read. The request
     * is consumed after the read, so a second upload for the same request still fails with the 409 there.
     */
    suspend fun requireCompactionRequest(boardId: Uuid, userId: Uuid, upToSeq: Long) {
        val room = rooms[boardId]
        val valid = room?.mutex?.withLock { isOpenRequest(room, userId, upToSeq) } ?: false
        if (!valid) throw notRequested(boardId, upToSeq)
    }

    /** Room lock held. */
    private fun isOpenRequest(room: Room, userId: Uuid, upToSeq: Long): Boolean {
        val request = room.compaction
        return request != null && request.userId == userId && request.upToSeq == upToSeq && clock.now() < request.expiresAt
    }

    private fun notRequested(boardId: Uuid, upToSeq: Long): DomainException {
        metrics.compaction(CompactionResult.REJECTED)
        return DomainException(
            ErrorCode.COLLAB_SNAPSHOT_NOT_REQUESTED,
            mapOf("boardId" to boardId.toString(), "upToSeq" to upToSeq.toString()),
        )
    }

    /** A snapshot up to [upToSeq] is stored and the log trimmed: the counters start from the database again. */
    suspend fun snapshotStored(boardId: Uuid, upToSeq: Long) {
        metrics.compaction(CompactionResult.STORED)
        val room = rooms[boardId] ?: return
        room.mutex.withLock {
            room.snapshotUpToSeq = maxOf(room.snapshotUpToSeq, upToSeq)
            room.logBytes = log.sizeAfter(boardId, 0)
            room.sinceSnapshotBytes = log.sizeAfter(boardId, room.snapshotUpToSeq)
            room.sinceSnapshotEntries = log.countAfter(boardId, room.snapshotUpToSeq)
        }
    }

    // ----------------------------------------------------------------------------------------------- leaving

    /** The socket is gone. Idempotent. */
    suspend fun leave(session: Session) {
        if (!session.markLeft()) return
        if (session.closeOrder == null) metrics.closed(CLIENT)
        session.markGone()
        val room = registryLock.withLock {
            rooms[session.boardId]?.also { room ->
                room.sessions.remove(session.id)
                if (room.sessions.isEmpty()) rooms.remove(session.boardId, room)
            }
        } ?: return
        room.mutex.withLock { if (session.live) broadcast(room, except = null, frame = ServerFrames.peerLeft(session.from)) }
    }

    /** Closes the session after the frames already queued; clean-up (PEER_LEFT, room removal) follows in the background. */
    private fun terminate(session: Session, code: Int, reason: String) {
        if (session.markClosed(code, reason)) {
            metrics.closed(code.toString())
            scope.launch { leave(session) }
        }
    }

    /** The board is deleted (or the server stops): every session of the room is closed with [code]. */
    suspend fun closeRoom(boardId: Uuid, code: Int, reason: String) {
        val room = registryLock.withLock { rooms.remove(boardId) } ?: return
        room.sessions.values.forEach { session ->
            if (session.markClosed(code, reason)) metrics.closed(code.toString())
            session.markLeft()
        }
    }

    /** The server stops: all sessions get 1001, clients reconnect with backoff. */
    suspend fun closeAll() {
        rooms.keys.toList().forEach { closeRoom(it, CLOSE_GOING_AWAY, "server shutting down") }
    }

    // ------------------------------------------------------------------------------------------------- sweeping

    /**
     * One pass of the periodic maintenance (a few seconds apart, see CollabMaintenance): token expiry (4401), idle
     * (4408), the ACL re-check (S2.3 safety net, every minute) and expired compaction requests.
     */
    suspend fun sweep() {
        val now = clock.now()
        val sessions = rooms.values.flatMap { it.sessions.values }.filterNot { it.isClosed }
        for (session in sessions) {
            when {
                now >= session.tokenExpiresAt -> terminate(session, CLOSE_TOKEN_EXPIRED, "token expired")
                now - session.lastActivity >= limits.idleTimeoutSeconds.seconds -> terminate(session, CLOSE_IDLE, "idle")
            }
        }
        if (now - lastAclCheck >= limits.aclRecheckSeconds.seconds) {
            lastAclCheck = now
            recheckRoles(sessions.filterNot { it.isClosed })
        }
        for (room in rooms.values) room.mutex.withLock { requestCompactionIfDue(room, now, preferred = null) }
    }

    /** Re-evaluates the role of every open session now (an access rule changed, S2.3). */
    suspend fun recheckAll() = recheckRoles(rooms.values.flatMap { it.sessions.values }.filterNot { it.isClosed })

    private suspend fun recheckRoles(sessions: List<Session>) {
        for ((key, group) in sessions.groupBy { it.boardId to it.participant }) {
            val role = try {
                access.roleOf(key.first, key.second)
            } catch (e: CancellationException) {
                throw e
            } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                // a failing check is no reason to throw everybody out; the next pass asks again
                logger.warn("collab role check failed", LOG_BOARD to key.first.toString(), "error.type" to e.javaClass.simpleName)
                continue
            }
            applyRole(group, role)
        }
    }

    private fun applyRole(group: List<Session>, role: CollabRole?) {
        for (session in group) {
            when {
                role == null -> terminate(session, CLOSE_FORBIDDEN, "access lost")
                session.role != role -> {
                    session.role = role
                    session.offer(ServerFrames.role(PeerJson.role(role.name)))
                }
            }
        }
    }

    companion object {
        const val CLOSE_NORMAL = 1000
        const val CLOSE_GOING_AWAY = 1001
        const val CLOSE_TOO_BIG = 1009
        const val CLOSE_SERVER_ERROR = 1011
        const val CLOSE_PROTOCOL = 4400
        const val CLOSE_TOKEN_EXPIRED = 4401
        const val CLOSE_FORBIDDEN = 4403
        const val CLOSE_BOARD_DELETED = 4404
        const val CLOSE_IDLE = 4408
        const val CLOSE_REPLACED = 4410
        const val CLOSE_BOARD_FULL = 4413
        const val CLOSE_RATE_LIMIT = 4429
        private const val LOG_BOARD = "collab.board.id"
        private const val CLIENT = "client"
    }
}
