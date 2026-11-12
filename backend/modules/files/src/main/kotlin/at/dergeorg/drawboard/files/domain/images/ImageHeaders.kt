// A parser of binary file formats: the numbers are the offsets and markers of the format, each named where it carries meaning in
// a comment; splitting the checks of a header into more functions would only hide the byte layout it mirrors.
@file:Suppress("MagicNumber", "ReturnCount", "CyclomaticComplexMethod", "LoopWithTooManyJumpStatements")

package at.dergeorg.drawboard.files.domain.images

/**
 * Width and height in pixels. [progressive] is true for a JPEG whose frame header is a progressive one (SOF2, 6, 10, 14): the
 * decoder has to hold every coefficient of the image, whatever the subsampling asks for (about 6 bytes a pixel, natively).
 */
internal data class Dimensions(val width: Int, val height: Int, val progressive: Boolean = false) {
    val pixels: Long get() = width.toLong() * height.toLong()
}

/**
 * Reads the pixel size of an image from its HEADER, without decoding a single pixel (S4.8: the size is known and
 * capped before anything is decoded). Works on a prefix of the file; returns null when the header is truncated, not of
 * the claimed format or does not carry a size.
 */
internal object ImageHeaders {

    /** How much of a file is looked at: a JPEG may carry large metadata segments before its frame header. */
    const val PREFIX_BYTES = 4 * 1024 * 1024

    fun dimensions(mediaType: String, prefix: ByteArray): Dimensions? = when (mediaType) {
        "image/png" -> png(prefix)
        "image/gif" -> gif(prefix)
        "image/webp" -> webp(prefix)
        "image/jpeg" -> jpeg(prefix)
        else -> null
    }?.takeIf { it.width > 0 && it.height > 0 }

    private fun png(b: ByteArray): Dimensions? {
        // 8 byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
        if (b.size < PNG_HEADER || String(b, PNG_TYPE_AT, 4, Charsets.ISO_8859_1) != "IHDR") return null
        return Dimensions(int32be(b, PNG_WIDTH_AT), int32be(b, PNG_WIDTH_AT + 4))
    }

    private fun gif(b: ByteArray): Dimensions? {
        if (b.size < GIF_HEADER) return null
        return Dimensions(int16le(b, GIF_WIDTH_AT), int16le(b, GIF_WIDTH_AT + 2))
    }

    private fun webp(b: ByteArray): Dimensions? {
        val riff = b.size >= WEBP_MIN && ascii(b, 0) == "RIFF" && ascii(b, 8) == "WEBP"
        if (!riff) return null
        return when (ascii(b, 12)) {
            "VP8 " -> if (b.size >= VP8_END) {
                Dimensions(int16le(b, VP8_WIDTH_AT) and VP8_MASK, int16le(b, VP8_WIDTH_AT + 2) and VP8_MASK)
            } else null
            "VP8L" -> if (b.size >= VP8L_END) {
                val bits = int32le(b, VP8L_BITS_AT)
                Dimensions((bits and VP8L_MASK) + 1, ((bits ushr VP8L_HEIGHT_SHIFT) and VP8L_MASK) + 1)
            } else null
            "VP8X" -> if (b.size >= VP8X_END) Dimensions(int24le(b, VP8X_WIDTH_AT) + 1, int24le(b, VP8X_WIDTH_AT + 3) + 1) else null
            else -> null
        }
    }

    /** Walks the segments to the first frame header (SOF0-SOF15 except DHT, JPG, DAC); SOF2/6/10/14 are the progressive ones. */
    private fun jpeg(b: ByteArray): Dimensions? {
        if (b.size < 4 || b[0] != 0xFF.toByte() || b[1] != 0xD8.toByte()) return null
        var at = 2
        while (at + 4 <= b.size) {
            if (b[at] != 0xFF.toByte()) return null
            val marker = b[at + 1].toInt() and 0xFF
            if (marker == 0xFF) { // fill byte
                at++
                continue
            }
            if (marker == 0xD8 || marker == 0x01 || marker in 0xD0..0xD7) { // standalone markers
                at += 2
                continue
            }
            if (marker == 0xD9 || marker == 0xDA) return null // end of image / start of scan before any frame header
            val length = int16be(b, at + 2)
            if (length < 2) return null
            val isFrame = marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            if (isFrame) {
                if (at + 9 > b.size) return null
                return Dimensions(width = int16be(b, at + 7), height = int16be(b, at + 5), progressive = marker in PROGRESSIVE_FRAMES)
            }
            at += 2 + length
        }
        return null
    }

    private fun ascii(b: ByteArray, at: Int) = String(b, at, 4, Charsets.ISO_8859_1)
    private fun int16be(b: ByteArray, at: Int) = ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)
    private fun int16le(b: ByteArray, at: Int) = ((b[at + 1].toInt() and 0xFF) shl 8) or (b[at].toInt() and 0xFF)
    private fun int24le(b: ByteArray, at: Int) = int16le(b, at) or ((b[at + 2].toInt() and 0xFF) shl 16)
    private fun int32be(b: ByteArray, at: Int) = (int16be(b, at) shl 16) or int16be(b, at + 2)
    private fun int32le(b: ByteArray, at: Int) = int16le(b, at) or (int16le(b, at + 2) shl 16)

    /** SOF2, SOF6, SOF10 and SOF14: progressive DCT (Huffman and arithmetic coded, differential or not). */
    private val PROGRESSIVE_FRAMES = setOf(0xC2, 0xC6, 0xCA, 0xCE)
    private const val PNG_TYPE_AT = 12
    private const val PNG_WIDTH_AT = 16
    private const val PNG_HEADER = 24
    private const val GIF_WIDTH_AT = 6
    private const val GIF_HEADER = 10
    private const val WEBP_MIN = 30
    private const val VP8_WIDTH_AT = 26
    private const val VP8_END = 30
    private const val VP8_MASK = 0x3FFF
    private const val VP8L_BITS_AT = 21
    private const val VP8L_END = 25
    private const val VP8L_MASK = 0x3FFF
    private const val VP8L_HEIGHT_SHIFT = 14
    private const val VP8X_WIDTH_AT = 24
    private const val VP8X_END = 30
}
