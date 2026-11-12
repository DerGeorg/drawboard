package at.dergeorg.drawboard.collab.domain.rooms

import at.dergeorg.drawboard.collab.domain.protocol.PeerJson
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabLimits
import at.dergeorg.drawboard.collab.domain.rooms.model.CollabRole
import at.dergeorg.drawboard.collab.domain.rooms.model.Participant
import at.dergeorg.drawboard.collab.domain.rooms.provides.CloseOrder
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabConnection
import kotlinx.coroutines.channels.ChannelResult
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ChannelIterator
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.channels.ReceiveChannel
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The state of one open WebSocket. Fields marked "room lock" are only touched while the room's mutex is held; the
 * `@Volatile` ones are read by the sweep and by other sessions' broadcasts without it.
 */
internal class Session(
    val id: Uuid,
    val boardId: Uuid,
    val userId: Uuid,
    val displayName: String,
    val tokenExpiresAt: Instant,
    role: CollabRole,
    val participant: Participant,
    /** Where a guest connected from; null for signed-in users. */
    val clientAddress: String?,
    limits: CollabLimits,
    now: Instant,
) {
    /**
     * Frames for the client; bounded by their number AND by their bytes ([CollabLimits.outboundBytes]) - a client that
     * cannot keep up is closed (1011), never buffered without limit. Fill it only with [offer] and [send].
     */
    private val outbound = Channel<ByteArray>(limits.outboundBuffer)

    private val maxQueuedBytes = limits.outboundBytes

    /** Bytes of the frames in [outbound] that the client has not taken yet. */
    private val queuedBytes = AtomicLong(0)

    /** Signals that the client took a frame, for a join that waits for room. */
    private val taken = Channel<Unit>(Channel.CONFLATED)

    /** What the WebSocket layer reads; every frame it takes gives its bytes back. */
    val frames: ReceiveChannel<ByteArray> = CountingChannel(outbound, ::release)

    /** Room lock. Bytes of [pending]. */
    var pendingBytes: Long = 0

    val color: String = PeerJson.colorFor(userId)

    val updateBucket = RateBucket(limits.updatesPerSecond, limits.updateBurst, now)
    val awarenessBucket = RateBucket(limits.awarenessPerSecond, limits.awarenessBurst, now)

    /** Setting it rebuilds [from], so every later frame names the new role. */
    @Volatile
    var role: CollabRole = role
        set(value) {
            field = value
            refreshFrom()
        }

    /** The Yjs `clientID`, bound by the first awareness frame (S2.6). */
    @Volatile
    var clientId: Long? = null
        private set

    @Volatile
    var lastActivity: Instant = now

    /** Forbidden messages so far (S2.4). */
    var violations: Int = 0

    /** Room lock. false while the join replays the log; broadcasts are parked in [pending] meanwhile. */
    var live: Boolean = false

    /** Room lock. */
    val pending = ArrayList<ByteArray>()

    private val closing = AtomicBoolean(false)
    private val left = AtomicBoolean(false)

    @Volatile
    var closeOrder: CloseOrder? = null
        private set

    /** The sender JSON of this session; it grows a `clientId` once one is bound and follows [role]. */
    @Volatile
    var from: String = buildFrom()
        private set

    val isClosed: Boolean get() = closing.get()

    fun bindClientId(value: Long) {
        clientId = value
        refreshFrom()
    }

    /**
     * The role re-check and the first awareness frame may change [from] at the same time; under the lock the later
     * of the two reads both new values, so neither change is lost.
     */
    @Synchronized
    private fun refreshFrom() {
        from = buildFrom()
    }

    private fun buildFrom(): String =
        PeerJson.from(userId, displayName, guest = participant.guest, color = color, role = role.name, clientId = clientId)

    /**
     * Queues a frame without waiting; false if the session is closed or its buffer is full - by frames or by bytes.
     * A frame always fits an empty buffer, however big: a 20 MB snapshot must be sendable.
     */
    fun offer(frame: ByteArray): Boolean {
        if (isClosed || !reserve(frame.size)) return false
        if (outbound.trySend(frame).isSuccess) return true
        release(frame.size)
        return false
    }

    /** Queues a frame and waits for room (frames and bytes); throws [ClosedSendChannelException] if the session ends. */
    suspend fun send(frame: ByteArray) {
        while (!reserve(frame.size)) {
            if (isClosed) throw ClosedSendChannelException(null)
            try {
                taken.receive()
            } catch (_: ClosedReceiveChannelException) {
                throw ClosedSendChannelException(null)
            }
        }
        try {
            outbound.send(frame)
        } catch (@Suppress("TooGenericExceptionCaught") e: Throwable) {
            release(frame.size)
            throw e
        }
    }

    private fun reserve(size: Int): Boolean {
        while (true) {
            val current = queuedBytes.get()
            if (current > 0 && current + size > maxQueuedBytes) return false
            if (queuedBytes.compareAndSet(current, current + size)) return true
        }
    }

    private fun release(size: Int) {
        queuedBytes.addAndGet(-size.toLong())
        taken.trySend(Unit)
    }

    /** Marks the session as closing with [code]; the frames already queued are still delivered. False if it already was. */
    fun markClosed(code: Int, reason: String): Boolean {
        if (!closing.compareAndSet(false, true)) return false
        closeOrder = CloseOrder(code, reason)
        outbound.close()
        taken.close()
        return true
    }

    /** The client left (or the server closes the room): no more frames, no close order of ours. */
    fun markGone() {
        if (closing.compareAndSet(false, true)) {
            outbound.close()
            taken.close()
        }
    }

    /** true exactly once: the caller removes the session from its room. */
    fun markLeft(): Boolean = left.compareAndSet(false, true)
}

/** The [CollabConnection] of a [Session]: forwards to the registry that owns the rooms. */
internal class SessionConnection(private val session: Session, private val rooms: RoomRegistry) : CollabConnection {

    override val frames: ReceiveChannel<ByteArray> get() = session.frames

    override val closeOrder: CloseOrder? get() = session.closeOrder

    override suspend fun onBinary(frame: ByteArray) = rooms.receive(session, frame)

    override suspend fun onText() = rooms.rejectText(session)

    override suspend fun disconnected() = rooms.leave(session)
}

/**
 * The read side of a session's buffer: every frame taken here calls [onTaken] with its size, so the session knows how
 * many bytes are still queued. Only the ways to take a frame that the WebSocket layer uses are counted (no `onReceive`
 * clauses).
 */
private class CountingChannel(
    private val delegate: ReceiveChannel<ByteArray>,
    private val onTaken: (Int) -> Unit,
) : ReceiveChannel<ByteArray> by delegate {

    override suspend fun receive(): ByteArray = delegate.receive().also { onTaken(it.size) }

    override suspend fun receiveCatching(): ChannelResult<ByteArray> =
        delegate.receiveCatching().also { it.getOrNull()?.let { f -> onTaken(f.size) } }

    override fun tryReceive(): ChannelResult<ByteArray> = delegate.tryReceive().also { it.getOrNull()?.let { f -> onTaken(f.size) } }

    override fun iterator(): ChannelIterator<ByteArray> {
        val inner = delegate.iterator()
        return object : ChannelIterator<ByteArray> {
            override suspend fun hasNext(): Boolean = inner.hasNext()

            override fun next(): ByteArray = inner.next().also { onTaken(it.size) }
        }
    }
}
