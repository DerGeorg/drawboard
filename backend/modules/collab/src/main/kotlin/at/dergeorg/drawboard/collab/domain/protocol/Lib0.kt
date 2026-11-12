package at.dergeorg.drawboard.collab.domain.protocol

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/** A frame or payload that does not follow `drawboard.v1`. The session is closed with 4400. */
internal class ProtocolViolation(message: String) : RuntimeException(message)

/**
 * Reads the encodings of `lib0/encoding` that the protocol uses: `varuint` (unsigned LEB128, at most 8 bytes, values
 * below 2^53) and `varstring` (`varuint` byte length, then UTF-8). Anything malformed is a [ProtocolViolation].
 */
internal class Lib0Reader(private val bytes: ByteArray, private var position: Int = 0) {

    val remaining: Int get() = bytes.size - position

    fun readVarUint(): Long {
        var value = 0L
        for (index in 0 until MAX_VARUINT_BYTES) {
            if (position >= bytes.size) throw ProtocolViolation("truncated varuint")
            val next = bytes[position++].toInt() and BYTE_MASK
            value = value or ((next and PAYLOAD_BITS).toLong() shl (index * BITS_PER_BYTE))
            if (next <= PAYLOAD_BITS) {
                if (value > MAX_VALUE) throw ProtocolViolation("varuint above 2^53")
                return value
            }
        }
        throw ProtocolViolation("varuint longer than $MAX_VARUINT_BYTES bytes")
    }

    fun readVarString(): String {
        val length = readVarUint()
        if (length > remaining) throw ProtocolViolation("varstring longer than the frame")
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        try {
            val text = decoder.decode(ByteBuffer.wrap(bytes, position, length.toInt())).toString()
            position += length.toInt()
            return text
        } catch (_: CharacterCodingException) {
            throw ProtocolViolation("varstring is not valid UTF-8")
        }
    }

    /** The rest of the frame (`bytes` in the specification), without length prefix. */
    fun readRest(): ByteArray = bytes.copyOfRange(position, bytes.size).also { position = bytes.size }

    companion object {
        const val MAX_VARUINT_BYTES = 8
        const val MAX_VALUE = (1L shl 53) - 1
        private const val BITS_PER_BYTE = 7
        private const val PAYLOAD_BITS = 0x7f
        private const val BYTE_MASK = 0xff
    }
}

/** Writes the same encodings. */
internal class Lib0Writer(initialSize: Int = DEFAULT_SIZE) {
    private val out = ByteArrayOutputStream(initialSize)

    fun type(code: Int): Lib0Writer = apply { out.write(code) }

    fun varUint(value: Long): Lib0Writer = apply {
        require(value in 0..Lib0Reader.MAX_VALUE) { "varuint out of range: $value" }
        var rest = value
        while (rest > PAYLOAD_BITS) {
            out.write(((rest and PAYLOAD_BITS.toLong()).toInt()) or CONTINUATION)
            rest = rest ushr BITS_PER_BYTE
        }
        out.write(rest.toInt())
    }

    fun varString(text: String): Lib0Writer = apply {
        val encoded = text.toByteArray(Charsets.UTF_8)
        varUint(encoded.size.toLong())
        out.write(encoded)
    }

    fun bytes(data: ByteArray): Lib0Writer = apply { out.write(data) }

    fun toByteArray(): ByteArray = out.toByteArray()

    private companion object {
        const val DEFAULT_SIZE = 32
        const val BITS_PER_BYTE = 7
        const val PAYLOAD_BITS = 0x7f
        const val CONTINUATION = 0x80
    }
}
