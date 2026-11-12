// A parser of binary file formats: the numbers are the offsets and markers of the format, each named where it carries meaning in
// a comment; splitting the checks of a header into more functions would only hide the byte layout it mirrors.
@file:Suppress("MagicNumber", "ReturnCount", "CyclomaticComplexMethod", "ComplexCondition")

package at.dergeorg.drawboard.files.domain.images

/**
 * Removes EXIF/XMP (APP1), IPTC (APP13) and comments from the header of a JPEG - location (GPS), camera and author
 * must not travel with a file that is shown to a whole board (S4.8, the SHOULD for JPEG originals). The one thing kept
 * is the orientation: a minimal EXIF block that carries only that tag, so a photo taken upright stays upright. Colour
 * profiles (APP2 starting `ICC_PROFILE`), JFIF and the image data are untouched; any other APP2 goes - the multi-picture
 * block (`MPF`) of a camera JPEG holds preview JPEGs that can carry EXIF of their own (M3 backend review, SHOULD 3).
 */
internal object JpegMetadata {

    /** What the walk over the header segments found. */
    sealed interface Outcome

    /** The walk reached the start of the scan and there was nothing to remove: the file is clean as it is. */
    data object NothingToStrip : Outcome

    /** The walk reached the start of the scan; [head] replaces the first [replacedBytes] bytes of the file. */
    class Stripped(val head: ByteArray, val replacedBytes: Int) : Outcome

    /**
     * The walk did not reach the start of the scan - not a JPEG, a segment that is cut off or has an impossible length,
     * no scan within the prefix. Nothing is known about the rest of the header: the caller refuses the file, it never
     * guesses (not even by looking for the bytes of a start of scan).
     */
    data object WalkFailed : Outcome

    /** Walks the segments of [prefix] up to the start of the scan. */
    fun strip(prefix: ByteArray): Outcome {
        if (prefix.size < 4 || prefix[0] != 0xFF.toByte() || prefix[1] != 0xD8.toByte()) return WalkFailed
        val kept = java.io.ByteArrayOutputStream()
        kept.write(SOI)
        var at = 2
        var removed = false
        var orientation: Int? = null
        while (at + 4 <= prefix.size) {
            if (prefix[at] != 0xFF.toByte()) return WalkFailed
            val marker = prefix[at + 1].toInt() and 0xFF
            if (marker == 0xFF) {
                at++
                continue
            }
            if (marker == SOS) {
                if (!removed) return NothingToStrip
                orientation?.let { kept.write(minimalExif(it)) }
                return Stripped(kept.toByteArray(), at)
            }
            if (marker == 0xD8 || marker == 0x01 || marker in 0xD0..0xD7 || marker == 0xD9) return WalkFailed
            val length = ((prefix[at + 2].toInt() and 0xFF) shl 8) or (prefix[at + 3].toInt() and 0xFF)
            if (length < 2 || at + 2 + length > prefix.size) return WalkFailed
            val drop = marker == APP1 || marker == APP13 || marker == COM || (marker == APP2 && !isIccProfile(prefix, at + 4, length - 2))
            if (drop) {
                removed = true
                if (marker == APP1) orientation = orientation ?: orientationOf(prefix, at + 4, length - 2)
            } else {
                kept.write(prefix, at, 2 + length)
            }
            at += 2 + length
        }
        return WalkFailed
    }

    /** Whether an APP2 payload starts with `ICC_PROFILE\0` - the one APP2 that is kept. */
    private fun isIccProfile(b: ByteArray, from: Int, length: Int): Boolean =
        length >= ICC_SIGNATURE.size && ICC_SIGNATURE.indices.all { b[from + it] == ICC_SIGNATURE[it] }

    /** The Orientation tag (1-8) of an EXIF block, null if this is not EXIF or has none. Bounds-checked everywhere. */
    internal fun orientationOf(b: ByteArray, from: Int, length: Int): Int? {
        val end = from + length
        if (length < EXIF_HEADER + TIFF_HEADER || end > b.size) return null
        if (String(b, from, 6, Charsets.ISO_8859_1) != "Exif\u0000\u0000") return null
        val tiff = from + EXIF_HEADER
        val bigEndian = when (String(b, tiff, 2, Charsets.ISO_8859_1)) {
            "MM" -> true
            "II" -> false
            else -> return null
        }
        fun u16(at: Int) = if (bigEndian) ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)
        else ((b[at + 1].toInt() and 0xFF) shl 8) or (b[at].toInt() and 0xFF)
        fun u32(at: Int) = if (bigEndian) (u16(at).toLong() shl 16) or u16(at + 2).toLong()
        else (u16(at + 2).toLong() shl 16) or u16(at).toLong()
        if (u16(tiff + 2) != TIFF_MAGIC) return null
        val ifd = tiff + u32(tiff + 4).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        if (ifd < tiff || ifd + 2 > end) return null
        val entries = u16(ifd)
        for (i in 0 until entries) {
            val entry = ifd + 2 + i * IFD_ENTRY
            if (entry + IFD_ENTRY > end) return null
            if (u16(entry) == ORIENTATION_TAG) return u16(entry + 8).takeIf { it in 1..8 }
        }
        return null
    }

    private fun minimalExif(orientation: Int): ByteArray {
        val tiff = byteArrayOf(
            'M'.code.toByte(), 'M'.code.toByte(), 0, TIFF_MAGIC.toByte(), 0, 0, 0, 8, // header, IFD0 at 8
            0, 1, // one entry
            0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation.toByte(), 0, 0, // Orientation, SHORT, count 1, value
            0, 0, 0, 0, // no next IFD
        )
        val payload = "Exif\u0000\u0000".toByteArray(Charsets.ISO_8859_1) + tiff
        val length = payload.size + 2
        return byteArrayOf(0xFF.toByte(), APP1.toByte(), (length shr 8).toByte(), length.toByte()) + payload
    }

    private val SOI = byteArrayOf(0xFF.toByte(), 0xD8.toByte())
    private const val SOS = 0xDA
    private const val APP1 = 0xE1
    private const val APP2 = 0xE2
    private val ICC_SIGNATURE = "ICC_PROFILE\u0000".toByteArray(Charsets.ISO_8859_1)
    private const val APP13 = 0xED
    private const val COM = 0xFE
    private const val EXIF_HEADER = 6
    private const val TIFF_HEADER = 8
    private const val TIFF_MAGIC = 42
    private const val IFD_ENTRY = 12
    private const val ORIENTATION_TAG = 0x0112
}
