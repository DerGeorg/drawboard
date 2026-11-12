package at.dergeorg.drawboard.collab.domain.protocol

/** The first byte of every frame of `drawboard.v1` (docs/collab-protocol.md in the API repository). */
internal object FrameType {
    // client -> server
    const val UPDATE = 0x01
    const val AWARENESS = 0x02
    const val PING = 0x03

    // server -> client
    const val WELCOME = 0x80
    const val SNAPSHOT = 0x81
    const val SERVER_UPDATE = 0x82
    const val SYNCED = 0x83
    const val ACK = 0x84
    const val SERVER_AWARENESS = 0x85
    const val PEER_JOINED = 0x86
    const val PEER_LEFT = 0x87
    const val COMPACT = 0x88
    const val PONG = 0x89
    const val ROLE = 0x8A
}

/** A message a client may send. Unknown types are a [ProtocolViolation] (4400). */
internal sealed interface ClientFrame {
    /** One Yjs update (v1). */
    class Update(val bytes: ByteArray) : ClientFrame

    /** A y-protocols awareness update, not yet checked ([AwarenessPayload]). */
    class Awareness(val bytes: ByteArray) : ClientFrame

    data object Ping : ClientFrame

    companion object {
        /** Reads one binary frame. */
        fun decode(frame: ByteArray): ClientFrame {
            if (frame.isEmpty()) throw ProtocolViolation("empty frame")
            val payload = frame.copyOfRange(1, frame.size)
            val decoded = when (frame[0].toInt() and BYTE_MASK) {
                FrameType.UPDATE -> Update(payload)
                FrameType.AWARENESS -> Awareness(payload)
                FrameType.PING -> Ping.takeIf { payload.isEmpty() }
                else -> null
            }
            // an unknown type, a PING with payload, an UPDATE or AWARENESS without one
            return decoded?.takeUnless { (it is Update && payload.isEmpty()) || (it is Awareness && payload.isEmpty()) }
                ?: throw ProtocolViolation("invalid message")
        }

        private const val BYTE_MASK = 0xff
    }
}

/** Builds the frames the server sends - one function per message type of the specification. */
@Suppress("TooManyFunctions")
internal object ServerFrames {

    fun welcome(json: String): ByteArray = Lib0Writer().type(FrameType.WELCOME).varString(json).toByteArray()

    fun snapshot(upToSeq: Long, data: ByteArray): ByteArray =
        Lib0Writer(data.size + HEADER).type(FrameType.SNAPSHOT).varUint(upToSeq).bytes(data).toByteArray()

    fun update(seq: Long, data: ByteArray): ByteArray =
        Lib0Writer(data.size + HEADER).type(FrameType.SERVER_UPDATE).varUint(seq).bytes(data).toByteArray()

    fun synced(headSeq: Long): ByteArray = Lib0Writer().type(FrameType.SYNCED).varUint(headSeq).toByteArray()

    fun ack(seq: Long): ByteArray = Lib0Writer().type(FrameType.ACK).varUint(seq).toByteArray()

    fun awareness(from: String, payload: ByteArray): ByteArray =
        Lib0Writer(payload.size + from.length + HEADER).type(FrameType.SERVER_AWARENESS).varString(from).bytes(payload).toByteArray()

    fun peerJoined(from: String): ByteArray = Lib0Writer().type(FrameType.PEER_JOINED).varString(from).toByteArray()

    fun peerLeft(from: String): ByteArray = Lib0Writer().type(FrameType.PEER_LEFT).varString(from).toByteArray()

    fun compact(upToSeq: Long): ByteArray = Lib0Writer().type(FrameType.COMPACT).varUint(upToSeq).toByteArray()

    fun pong(): ByteArray = Lib0Writer().type(FrameType.PONG).toByteArray()

    fun role(json: String): ByteArray = Lib0Writer().type(FrameType.ROLE).varString(json).toByteArray()

    private const val HEADER = 16
}
