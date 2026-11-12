// A parser of binary file formats: the numbers are the offsets and markers of the format, each named where it carries meaning in
// a comment; splitting the checks of a header into more functions would only hide the byte layout it mirrors.
@file:Suppress("MagicNumber", "ReturnCount")

package at.dergeorg.drawboard.files.domain.detect

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Tells Office Open XML and OpenDocument files apart from the entry NAMES in the ZIP's central directory (and, for
 * ODF, the stored `mimetype` entry) - without inflating anything (S4.11: Drawboard never unpacks Office files). The
 * caller supplies [read], a function that returns the bytes of a range of the file; nothing here touches the file
 * system. A file that is not a plain ZIP (ZIP64, truncated, central directory over [MAX_DIRECTORY_BYTES]) gives null.
 */
internal class ZipSniffer(private val size: Long, private val read: (from: Long, length: Int) -> ByteArray) {

    /** The allowlisted media type of the document, or null. */
    fun documentType(): String? {
        val directory = centralDirectory() ?: return null
        val names = directory.entries.map { it.name }.toSet()
        val odf = directory.entries.firstOrNull { it.name == "mimetype" }?.let(::storedText)
        return when {
            odf != null -> odf.takeIf { it in ODF_TYPES }
            "[Content_Types].xml" !in names -> null
            "word/document.xml" in names -> FileTypes.DOCX
            "xl/workbook.xml" in names -> FileTypes.XLSX
            "ppt/presentation.xml" in names -> FileTypes.PPTX
            else -> null
        }
    }

    private class Entry(val name: String, val method: Int, val compressedSize: Long, val localHeaderOffset: Long)

    private class Directory(val entries: List<Entry>)

    private fun centralDirectory(): Directory? {
        if (size < EOCD_MIN) return null
        val tailLength = minOf(size, (EOCD_MIN + MAX_COMMENT).toLong()).toInt()
        val tail = ByteBuffer.wrap(read(size - tailLength, tailLength)).order(ByteOrder.LITTLE_ENDIAN)
        val eocd = (tail.limit() - EOCD_MIN downTo 0).firstOrNull { tail.getInt(it) == EOCD_SIGNATURE } ?: return null
        val count = tail.getShort(eocd + ENTRIES_AT).toInt() and 0xFFFF
        val length = tail.getInt(eocd + DIRECTORY_SIZE_AT).toLong() and 0xFFFFFFFFL
        val offset = tail.getInt(eocd + DIRECTORY_OFFSET_AT).toLong() and 0xFFFFFFFFL
        val zip64 = count == 0xFFFF || length == 0xFFFFFFFFL || offset == 0xFFFFFFFFL
        if (zip64 || length > MAX_DIRECTORY_BYTES || offset + length > size) return null
        val directory = ByteBuffer.wrap(read(offset, length.toInt())).order(ByteOrder.LITTLE_ENDIAN)
        val entries = ArrayList<Entry>(count)
        var at = 0
        while (entries.size < count && at + ENTRY_FIXED <= directory.limit()) {
            if (directory.getInt(at) != CENTRAL_SIGNATURE) return null
            val nameLength = directory.getShort(at + NAME_LENGTH_AT).toInt() and 0xFFFF
            val extraLength = directory.getShort(at + EXTRA_LENGTH_AT).toInt() and 0xFFFF
            val commentLength = directory.getShort(at + COMMENT_LENGTH_AT).toInt() and 0xFFFF
            if (at + ENTRY_FIXED + nameLength > directory.limit()) return null
            val name = String(directory.array(), at + ENTRY_FIXED, nameLength, Charsets.UTF_8)
            entries += Entry(
                name = name,
                method = directory.getShort(at + METHOD_AT).toInt() and 0xFFFF,
                compressedSize = directory.getInt(at + COMPRESSED_SIZE_AT).toLong() and 0xFFFFFFFFL,
                localHeaderOffset = directory.getInt(at + LOCAL_OFFSET_AT).toLong() and 0xFFFFFFFFL,
            )
            at += ENTRY_FIXED + nameLength + extraLength + commentLength
        }
        return Directory(entries).takeIf { entries.size == count }
    }

    /** The text of a STORED (uncompressed) entry of at most 128 bytes - the `mimetype` entry of an OpenDocument file. */
    private fun storedText(entry: Entry): String? {
        if (entry.method != 0 || entry.compressedSize > MAX_MIMETYPE_BYTES) return null
        if (entry.localHeaderOffset + LOCAL_FIXED > size) return null
        val header = ByteBuffer.wrap(read(entry.localHeaderOffset, LOCAL_FIXED)).order(ByteOrder.LITTLE_ENDIAN)
        if (header.getInt(0) != LOCAL_SIGNATURE) return null
        val nameLength = header.getShort(LOCAL_NAME_AT).toInt() and 0xFFFF
        val extraLength = header.getShort(LOCAL_EXTRA_AT).toInt() and 0xFFFF
        val dataAt = entry.localHeaderOffset + LOCAL_FIXED + nameLength + extraLength
        if (dataAt + entry.compressedSize > size) return null
        return String(read(dataAt, entry.compressedSize.toInt()), Charsets.US_ASCII)
    }

    companion object {
        /** The largest central directory looked at; a ZIP with more entries than this is not an Office document. */
        const val MAX_DIRECTORY_BYTES = 4L * 1024 * 1024
        private const val MAX_COMMENT = 65_535
        private const val MAX_MIMETYPE_BYTES = 128L
        private const val EOCD_SIGNATURE = 0x06054b50
        private const val CENTRAL_SIGNATURE = 0x02014b50
        private const val LOCAL_SIGNATURE = 0x04034b50
        private const val EOCD_MIN = 22
        private const val ENTRIES_AT = 10
        private const val DIRECTORY_SIZE_AT = 12
        private const val DIRECTORY_OFFSET_AT = 16
        private const val ENTRY_FIXED = 46
        private const val METHOD_AT = 10
        private const val COMPRESSED_SIZE_AT = 20
        private const val NAME_LENGTH_AT = 28
        private const val EXTRA_LENGTH_AT = 30
        private const val COMMENT_LENGTH_AT = 32
        private const val LOCAL_OFFSET_AT = 42
        private const val LOCAL_FIXED = 30
        private const val LOCAL_NAME_AT = 26
        private const val LOCAL_EXTRA_AT = 28
        private val ODF_TYPES = setOf(FileTypes.ODT, FileTypes.ODS, FileTypes.ODP)
    }
}
