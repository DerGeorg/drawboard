package at.dergeorg.drawboard.collab.domain.rooms.provides

import kotlinx.coroutines.channels.ReceiveChannel

/** Why and how the server ends a session: the WebSocket close code (see the protocol document) and a short reason. */
data class CloseOrder(val code: Int, val reason: String)

/**
 * One open session as the WebSocket layer sees it - no Spring, no WebSocket types. The layer
 * 1. sends every element of [frames] as one binary message, in order;
 * 2. hands every received message to [onBinary] / [onText], one at a time;
 * 3. when [frames] ends, closes the socket with [closeOrder]; when the socket ends first, calls [disconnected].
 */
interface CollabConnection {

    /** Frames for the client. Completes when the session ends; then [closeOrder] says why. */
    val frames: ReceiveChannel<ByteArray>

    /** Set when [frames] has completed (null = the client left first). */
    val closeOrder: CloseOrder?

    suspend fun onBinary(frame: ByteArray)

    /** A text frame is a protocol violation (4400). */
    suspend fun onText()

    /** The socket is gone (closed by either side, or broken). Idempotent. */
    suspend fun disconnected()
}
