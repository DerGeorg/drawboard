package at.dergeorg.drawboard.files.domain.detect

import at.dergeorg.drawboard.files.domain.files.model.FileKind
import org.apache.tika.metadata.Metadata
import org.apache.tika.mime.MimeTypes
import org.apache.tika.io.TikaInputStream
import org.apache.tika.parser.ParseContext

/** One entry of the allowlist (S4.2): the media type, what kind of file it makes and the extensions a file name may have. */
internal data class AllowedType(val mediaType: String, val kind: FileKind, val extensions: Set<String>)

/**
 * The type allowlist and the detection against it (S4.2, S4.3): the type is read from the CONTENT by Apache Tika's
 * magic-byte detector (`tika-core`, no parsers, no file name, no client-supplied type). Anything not listed is not
 * allowed - SVG (an XML text) is never on the list. ZIP-based documents (Office Open XML, OpenDocument) are told apart
 * by [ZipSniffer] from the names in the central directory; their content is never unpacked (S4.11).
 */
internal object FileTypes {

    const val DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    const val XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    const val PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    const val ODT = "application/vnd.oasis.opendocument.text"
    const val ODS = "application/vnd.oasis.opendocument.spreadsheet"
    const val ODP = "application/vnd.oasis.opendocument.presentation"

    val ALLOWED: Map<String, AllowedType> = listOf(
        AllowedType("image/png", FileKind.IMAGE, setOf("png")),
        AllowedType("image/jpeg", FileKind.IMAGE, setOf("jpg", "jpeg")),
        AllowedType("image/gif", FileKind.IMAGE, setOf("gif")),
        AllowedType("image/webp", FileKind.IMAGE, setOf("webp")),
        AllowedType("video/mp4", FileKind.VIDEO, setOf("mp4")),
        AllowedType("video/webm", FileKind.VIDEO, setOf("webm")),
        AllowedType("application/pdf", FileKind.PDF, setOf("pdf")),
        AllowedType(DOCX, FileKind.DOCUMENT, setOf("docx")),
        AllowedType(XLSX, FileKind.DOCUMENT, setOf("xlsx")),
        AllowedType(PPTX, FileKind.DOCUMENT, setOf("pptx")),
        AllowedType(ODT, FileKind.DOCUMENT, setOf("odt")),
        AllowedType(ODS, FileKind.DOCUMENT, setOf("ods")),
        AllowedType(ODP, FileKind.DOCUMENT, setOf("odp")),
    ).associateBy { it.mediaType }

    /** What Tika says for a ZIP container: the real type needs a look at the entry names ([ZipSniffer]). */
    private val ZIP_CONTAINERS = setOf("application/zip", "application/x-tika-ooxml", "application/x-tika-msoffice-embedded")

    /** How many bytes from the start the detector needs; the upload keeps this much in memory. */
    const val HEAD_BYTES = 65_536

    /** The result of the magic-byte detection of the start of a file. */
    sealed interface Detection {
        /** A type of the allowlist (and not a ZIP container). */
        data class Known(val type: AllowedType) : Detection

        /** A ZIP: Office Open XML or OpenDocument - which one needs [ZipSniffer]. */
        data object Zip : Detection

        /** Anything else; [mediaType] is what was recognised, null when nothing was. */
        data class Other(val mediaType: String?) : Detection
    }

    private val mimeTypes: MimeTypes by lazy { MimeTypes.getDefaultMimeTypes() }

    /** Detects the type from the first bytes of a file. Never uses a file name. */
    fun detect(head: ByteArray): Detection {
        val detected = refine(TikaInputStream.get(head).use { mimeTypes.detect(it, Metadata(), ParseContext()) }.toString(), head)
        val allowed = ALLOWED[detected]
        return when {
            detected in ZIP_CONTAINERS -> Detection.Zip
            allowed != null && allowed.kind != FileKind.DOCUMENT -> Detection.Known(allowed)
            // an ODF/OOXML type from the magic bytes is checked against the entry names too (a forged "mimetype" entry)
            allowed != null -> Detection.Zip
            detected == "application/octet-stream" -> Detection.Other(null)
            else -> Detection.Other(detected)
        }
    }

    /**
     * Tika's magic for the two video containers is generic: the common MP4 brand `isom` is called QuickTime, and a WebM
     * is a Matroska file. The brand of the `ftyp` box and the `DocType` element are read here, from the same head; a
     * QuickTime movie (`qt  `) or a general Matroska file stays what it is - and so stays off the allowlist.
     */
    private fun refine(detected: String, head: ByteArray): String = when {
        detected in MP4_FAMILY && head.isMp4() -> "video/mp4"
        detected in MATROSKA_FAMILY && head.contains(DOC_TYPE_WEBM) -> "video/webm"
        else -> detected
    }

    private fun ByteArray.isMp4() = ascii(FTYP_AT, BRAND_LENGTH) == "ftyp" && ascii(BRAND_AT, BRAND_LENGTH) in MP4_BRANDS

    private fun ByteArray.ascii(from: Int, length: Int): String =
        if (size >= from + length) String(this, from, length, Charsets.ISO_8859_1) else ""

    /** The EBML `DocType` element (id 0x4282) holding "webm", within the first bytes where the header lives. */
    private fun ByteArray.contains(needle: ByteArray): Boolean {
        val limit = minOf(size, EBML_HEADER_BYTES) - needle.size
        return (0..limit).any { at -> needle.indices.all { this[at + it] == needle[it] } }
    }

    private val MP4_FAMILY = setOf("video/quicktime", "video/mp4", "application/mp4", "video/x-m4v")
    private val MP4_BRANDS = setOf("isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "cmfc")
    private val MATROSKA_FAMILY = setOf("application/x-matroska", "video/x-matroska", "video/webm", "audio/webm")
    private val DOC_TYPE_WEBM = byteArrayOf(
        0x42,
        0x82.toByte(),
        0x84.toByte(),
        'w'.code.toByte(),
        'e'.code.toByte(),
        'b'.code.toByte(),
        'm'.code.toByte(),
    )
    private const val EBML_HEADER_BYTES = 64
    private const val FTYP_AT = 4
    private const val BRAND_AT = 8
    private const val BRAND_LENGTH = 4

    /** Whether the file name's extension fits the detected type; a name without extension never does (S4.2). */
    fun extensionMatches(fileName: String, type: AllowedType): Boolean {
        val extension = fileName.substringAfterLast('.', "").lowercase()
        return extension in type.extensions
    }
}
