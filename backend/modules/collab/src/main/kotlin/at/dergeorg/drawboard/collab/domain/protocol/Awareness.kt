package at.dergeorg.drawboard.collab.domain.protocol

import tools.jackson.core.JacksonException
import tools.jackson.databind.json.JsonMapper
import java.security.MessageDigest
import kotlin.uuid.Uuid

/** One entry of a y-protocols awareness update. [state] is JSON text (or `null`). */
internal data class AwarenessEntry(val clientId: Long, val clock: Long, val state: String)

/** Checks the payload of an `AWARENESS` frame (S2.6). */
internal object AwarenessPayload {

    private val json = JsonMapper.builder().build()

    /**
     * The one entry of the update, or null if the update has more or fewer than one entry (the frame is dropped).
     * Malformed structure, trailing bytes or a state that is not JSON is a [ProtocolViolation]: other clients
     * `JSON.parse` the state, so it is checked here.
     */
    fun parse(payload: ByteArray): AwarenessEntry? {
        val reader = Lib0Reader(payload)
        val count = reader.readVarUint()
        if (count != 1L) return null
        val entry = AwarenessEntry(clientId = reader.readVarUint(), clock = reader.readVarUint(), state = reader.readVarString())
        if (reader.remaining != 0) throw ProtocolViolation("trailing bytes after the awareness entry")
        try {
            json.readTree(entry.state)
        } catch (_: JacksonException) {
            throw ProtocolViolation("awareness state is not JSON")
        }
        return entry
    }
}

/** The JSON texts the server writes into frames: the sender (`From`), the welcome message and the role change. */
internal object PeerJson {

    /** Fixed palette; the colour of a user is derived from the user id, so every client shows the same one. */
    private val PALETTE = listOf(
        "#e03131", "#c2255c", "#9c36b5", "#6741d9", "#3b5bdb", "#1971c2",
        "#0c8599", "#099268", "#2f9e44", "#66a80f", "#f08c00", "#e8590c",
    )

    private val json = JsonMapper.builder().build()

    /** Longest display name in `From`. */
    const val MAX_NAME_CHARS = 64

    private const val BYTE_MASK = 0xff

    fun colorFor(userId: Uuid): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(userId.toByteArray())
        return PALETTE[(digest[0].toInt() and BYTE_MASK) % PALETTE.size]
    }

    /**
     * `From` of the specification, built from the authenticated principal - never from client input. The display name
     * comes from the identity provider and is not bounded there, but it is sent to every peer with every awareness
     * frame, so it is cut to [MAX_NAME_CHARS] characters. [role] is the sender's current board role; receivers decide
     * from it whether a summon is honoured (Fable 2026-11-11, "Zoom-out, follow and summon"), so it is rebuilt whenever
     * the session's role changes.
     */
    fun from(userId: Uuid, name: String, guest: Boolean, color: String, role: String, clientId: Long?): String {
        val fields = linkedMapOf<String, Any>(
            "id" to userId.toString(),
            "name" to capName(name),
            "guest" to guest,
            "color" to color,
            "role" to role,
        )
        if (clientId != null) fields["clientId"] = clientId
        return json.writeValueAsString(fields)
    }

    /** At most [MAX_NAME_CHARS] characters (Unicode code points, so a surrogate pair is never split). */
    internal fun capName(name: String): String =
        if (name.codePointCount(0, name.length) <= MAX_NAME_CHARS) name else name.substring(0, name.offsetByCodePoints(0, MAX_NAME_CHARS))

    /** `WELCOME` payload; [self] is the JSON from [from]. */
    fun welcome(role: String, self: String, updateLimit: Int, awarenessLimit: Int): String =
        """{"role":${json.writeValueAsString(role)},"self":$self,"limits":{"update":$updateLimit,"awareness":$awarenessLimit}}"""

    fun role(role: String): String = """{"role":${json.writeValueAsString(role)}}"""
}
