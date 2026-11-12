package at.dergeorg.drawboard.files.domain.images

import java.nio.ByteBuffer
import java.nio.channels.SeekableByteChannel
import javax.imageio.stream.ImageInputStreamImpl

/**
 * An [javax.imageio.stream.ImageInputStream] straight over the channel of a stored blob: the decoder reads (and seeks) what it
 * needs, in pieces of at most [CHUNK] bytes, and nothing is cached - the original is never held in the heap as a whole
 * (M3 backend review, MUST 2). Closing it closes the channel.
 */
internal class ChannelImageInputStream(private val channel: SeekableByteChannel) : ImageInputStreamImpl() {

    private val single = ByteArray(1)

    override fun read(): Int = if (read(single, 0, 1) < 0) -1 else single[0].toInt() and BYTE_MASK

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        bitOffset = 0
        channel.position(streamPos)
        val buffer = ByteBuffer.wrap(b, off, minOf(len, CHUNK))
        var read = channel.read(buffer)
        while (read == 0) read = channel.read(buffer)
        if (read > 0) streamPos += read
        return read
    }

    override fun length(): Long = channel.size()

    override fun isCached(): Boolean = false

    override fun close() {
        super.close()
        channel.close()
    }

    companion object {
        /** The most one read from the channel asks for. */
        const val CHUNK = 64 * 1024
        private const val BYTE_MASK = 0xFF
    }
}
