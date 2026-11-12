package at.dergeorg.drawboard.collab.domain.protocol

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.uuid.Uuid

/**
 * The byte vectors below were produced by the real `lib0/encoding` and `y-protocols/awareness` of the frontend
 * (node_modules, lib0 + y-protocols + yjs), so both sides provably agree. Regenerate them with those packages if the
 * protocol ever changes.
 */
internal fun hex(text: String): ByteArray = text.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

class ProtocolTest {

    @Nested
    inner class VarUint {

        @Test
        fun `when encoding and decoding the lib0 vectors then bytes and values match in both directions`() {
            val vectors = mapOf(
                0L to "00", 1L to "01", 127L to "7f", 128L to "8001", 300L to "ac02", 16384L to "808001",
                1_048_576L to "808040", 4_294_967_296L to "8080808010", 9_007_199_254_740_991L to "ffffffffffffff0f",
            )
            vectors.forEach { (value, bytes) ->
                assertEquals(bytes, Lib0Writer().varUint(value).toByteArray().toHex(), "encoding of $value")
                assertEquals(value, Lib0Reader(hex(bytes)).readVarUint(), "decoding of $bytes")
            }
        }

        @Test
        fun `when a varuint is truncated or longer than 8 bytes then it is a protocol violation`() {
            assertFailsWith<ProtocolViolation>("truncated") { Lib0Reader(hex("80")).readVarUint() }
            assertFailsWith<ProtocolViolation>("9 bytes") { Lib0Reader(hex("808080808080808080")).readVarUint() }
        }

        @Test
        fun `when a varuint is 2 to the 53 or more then it is a protocol violation`() {
            assertFailsWith<ProtocolViolation>("2^53") { Lib0Reader(hex("8080808080808010")).readVarUint() }
        }
    }

    @Nested
    inner class VarString {

        @Test
        fun `when encoding and decoding the lib0 vectors then bytes and text match, multibyte characters included`() {
            val vectors = mapOf(
                "" to "00", "abc" to "03616263", "äöü€😀" to "0dc3a4c3b6c3bce282acf09f9880", "{\"a\":1}" to "077b2261223a317d",
            )
            vectors.forEach { (text, bytes) ->
                assertEquals(bytes, Lib0Writer().varString(text).toByteArray().toHex(), "encoding of $text")
                assertEquals(text, Lib0Reader(hex(bytes)).readVarString(), "decoding of $bytes")
            }
        }

        @Test
        fun `when a varstring is longer than the frame or not UTF-8 then it is a protocol violation`() {
            assertFailsWith<ProtocolViolation>("length beyond the frame") { Lib0Reader(hex("05616263")).readVarString() }
            assertFailsWith<ProtocolViolation>("invalid UTF-8") { Lib0Reader(hex("02c328")).readVarString() }
        }
    }

    @Nested
    inner class DecodingClientFrames {

        @Test
        fun `when decoding UPDATE AWARENESS and PING then each has its payload`() {
            val update = assertIs<ClientFrame.Update>(ClientFrame.decode(hex("01010102")), "update frame")
            val awareness = assertIs<ClientFrame.Awareness>(ClientFrame.decode(hex("020a")), "awareness frame")
            assertContentEquals(hex("010102"), update.bytes, "update payload")
            assertContentEquals(hex("0a"), awareness.bytes, "awareness payload")
            assertEquals(ClientFrame.Ping, ClientFrame.decode(hex("03")), "ping")
        }

        @Test
        fun `when decoding an empty frame an unknown type or an empty update then it is a protocol violation`() {
            assertFailsWith<ProtocolViolation>("empty frame") { ClientFrame.decode(ByteArray(0)) }
            assertFailsWith<ProtocolViolation>("server type from a client") { ClientFrame.decode(hex("8400")) }
            assertFailsWith<ProtocolViolation>("empty update") { ClientFrame.decode(hex("01")) }
            assertFailsWith<ProtocolViolation>("ping with payload") { ClientFrame.decode(hex("0300")) }
        }
    }

    @Nested
    inner class BuildingServerFrames {

        @Test
        fun `when building server frames then type and encodings follow the specification`() {
            assertEquals("8300", ServerFrames.synced(0).toHex(), "SYNCED head 0")
            assertEquals("84ac02", ServerFrames.ack(300).toHex(), "ACK 300")
            assertEquals("88808001", ServerFrames.compact(16384).toHex(), "COMPACT upToSeq 16384")
            assertEquals("89", ServerFrames.pong().toHex(), "PONG")
            assertEquals("8201abcd", ServerFrames.update(1, hex("abcd")).toHex(), "UPDATE seq 1 bytes abcd")
            assertEquals("8102ff", ServerFrames.snapshot(2, hex("ff")).toHex(), "SNAPSHOT upToSeq 2")
            assertEquals("86027b7d", ServerFrames.peerJoined("{}").toHex(), "PEER_JOINED From as varstring")
        }

        @Test
        fun `when wrapping awareness then the sender JSON comes first as a varstring and the payload follows unchanged`() {
            val payload = hex("012a01247b2275736572223a7b226e616d65223a2278227d2c22637572736f72223a5b312c325d7d")

            val frame = ServerFrames.awareness("{\"id\":\"x\"}", payload)

            val reader = Lib0Reader(frame, 1)
            assertEquals(0x85, frame[0].toInt() and 0xff, "type AWARENESS")
            assertEquals("{\"id\":\"x\"}", reader.readVarString(), "From")
            assertContentEquals(payload, reader.readRest(), "payload as sent")
        }
    }

    @Nested
    inner class Awareness {

        @Test
        fun `when parsing the y-protocols vector of one entry then client id clock and state are read`() {
            val entry = assertNotNull(
                AwarenessPayload.parse(hex("012a01247b2275736572223a7b226e616d65223a2278227d2c22637572736f72223a5b312c325d7d")),
                "one entry",
            )

            assertEquals(42L, entry.clientId, "clientID")
            assertEquals(1L, entry.clock, "clock")
            assertEquals("""{"user":{"name":"x"},"cursor":[1,2]}""", entry.state, "state")
        }

        @Test
        fun `when parsing a removal then the state is the JSON null`() {
            assertEquals("null", assertNotNull(AwarenessPayload.parse(hex("012a02046e756c6c")), "one entry").state, "state null")
        }

        @Test
        fun `when the update has two entries then it is dropped, not a violation`() {
            assertNull(AwarenessPayload.parse(hex("020701077b2261223a317dac0201077b2262223a327d")), "two entries from y-protocols")
            assertNull(AwarenessPayload.parse(hex("00")), "zero entries")
        }

        @Test
        fun `when the entry has trailing bytes or a state that is not JSON then it is a protocol violation`() {
            assertFailsWith<ProtocolViolation>("trailing bytes") { AwarenessPayload.parse(hex("012a02046e756c6c00")) }
            assertFailsWith<ProtocolViolation>("not JSON") { AwarenessPayload.parse(hex("012a0103787878")) }
            assertFailsWith<ProtocolViolation>("truncated") { AwarenessPayload.parse(hex("012a")) }
        }
    }

    @Nested
    inner class SenderJson {

        private val user = Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f")

        @Test
        fun `when building the sender then it has id name guest color and role, and clientId only once bound`() {
            val color = PeerJson.colorFor(user)

            assertEquals(
                """{"id":"$user","name":"Alice \"A\"","guest":false,"color":"$color","role":"EDITOR"}""",
                PeerJson.from(user, "Alice \"A\"", guest = false, color = color, role = "EDITOR", clientId = null),
                "From without client id, name escaped",
            )
            assertEquals(
                """{"id":"$user","name":"Alice","guest":false,"color":"$color","role":"VIEWER","clientId":42}""",
                PeerJson.from(user, "Alice", guest = false, color = color, role = "VIEWER", clientId = 42),
                "From with client id",
            )
        }

        @Test
        fun `when the display name is longer than 64 characters then From carries only the first 64`() {
            val color = PeerJson.colorFor(user)
            val long = "n".repeat(10_000)

            val from = PeerJson.from(user, long, guest = false, color = color, role = "OWNER", clientId = null)

            assertEquals(
                """{"id":"$user","name":"${"n".repeat(64)}","guest":false,"color":"$color","role":"OWNER"}""",
                from,
                "name cut to 64 characters",
            )
            assertEquals(long.take(64), PeerJson.capName(long), "cap function")
            assertEquals("x".repeat(64), PeerJson.capName("x".repeat(64)), "exactly 64 stays as it is")
        }

        @Test
        fun `when the cut falls inside a surrogate pair then the pair is not split`() {
            val emoji = "\uD83D\uDE00" // one character outside the BMP, two UTF-16 units
            val name = "a".repeat(63) + emoji + "tail"

            val capped = PeerJson.capName(name)

            assertEquals("a".repeat(63) + emoji, capped, "63 letters plus the whole emoji")
        }

        @Test
        fun `when deriving the color then the same user always gets the same one from the palette`() {
            assertEquals(PeerJson.colorFor(user), PeerJson.colorFor(user), "deterministic")
            assertEquals(true, Regex("#[0-9a-f]{6}").matches(PeerJson.colorFor(user)), "a hex color")
        }
    }
}
