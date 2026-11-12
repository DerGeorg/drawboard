package at.dergeorg.drawboard.plugins.domain.archive

import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipException
import java.util.zip.ZipInputStream

/** The files of an accepted plugin ZIP: path -> bytes, exactly as in the archive (directories are not kept). */
internal class UnpackedPlugin(val files: Map<String, ByteArray>)

/** Why a ZIP was refused: the `reason` codes of `PLUGINS_ARCHIVE_INVALID`, and the entry to blame where there is one. */
internal enum class ArchiveProblem {
    NOT_A_ZIP,
    TOO_MANY_ENTRIES,
    UNPACKED_TOO_LARGE,
    UNSAFE_PATH,
    FILE_TYPE_NOT_ALLOWED,
    MANIFEST_MISSING,
    ENTRY_MISSING,
}

/** Refuses the archive with [problem]: the guard helpers of this file return [Nothing], so a check reads as one line. */
internal fun refuse(problem: ArchiveProblem, path: String? = null): Nothing = throw archiveInvalid(problem, path)

internal fun archiveInvalid(problem: ArchiveProblem, path: String? = null) = DomainException(
    ErrorCode.PLUGINS_ARCHIVE_INVALID,
    buildMap {
        put("reason", problem.name)
        if (path != null) put("path", path.take(MAX_SHOWN_PATH))
    },
)

private const val MAX_SHOWN_PATH = 255

/**
 * Reads a plugin ZIP with every rule of S3.9 and docs/plugin-protocol.md - NOTHING is ever extracted to a file system:
 * the entries are held in memory and served by exact path match later, so a path can not escape anything. The limits
 * are counted WHILE unpacking (the sizes in the headers are what an attacker writes), the paths and file types checked
 * entry by entry, links refused, and a name used twice (ignoring case) is refused too.
 *
 * Order of the checks, as in the contract: the 20 MB cap of the upload itself is the caller's (413); here the entry
 * count, the unpacked size, the paths, the file types; the manifest and entry checks follow in the service.
 */
internal class PluginArchive(
    private val maxEntries: Int = MAX_ENTRIES,
    private val maxUnpackedBytes: Long = MAX_UNPACKED_BYTES,
) {

    fun unpack(zip: ByteArray): UnpackedPlugin {
        if (!looksLikeZip(zip)) refuse(ArchiveProblem.NOT_A_ZIP)
        rejectLinks(zip)
        val files = try {
            ZipInputStream(ByteArrayInputStream(zip)).use { readEntries(it) }
        } catch (_: ZipException) {
            refuse(ArchiveProblem.NOT_A_ZIP)
        }
        return UnpackedPlugin(files)
    }

    /** Every entry, checked as it is read: count, path, duplicates, file type, and the unpacked bytes of all together. */
    private fun readEntries(input: ZipInputStream): Map<String, ByteArray> {
        val files = LinkedHashMap<String, ByteArray>()
        val names = HashSet<String>()
        var unpacked = 0L
        var entries = 0
        generateSequence { input.nextEntry }.forEach { entry ->
            if (++entries > maxEntries) refuse(ArchiveProblem.TOO_MANY_ENTRIES)
            checkPath(entry.name)
            if (!names.add(entry.name.trimEnd('/').lowercase())) refuse(ArchiveProblem.UNSAFE_PATH, entry.name)
            if (!entry.isDirectory) {
                checkType(entry.name)
                val data = readLimited(input, maxUnpackedBytes - unpacked)
                unpacked += data.size
                files[entry.name] = data
            }
        }
        if (entries == 0) refuse(ArchiveProblem.NOT_A_ZIP)
        return files
    }

    /** At most [remaining] bytes of the current entry; one more is the end of the allowance (UNPACKED_TOO_LARGE). */
    private fun readLimited(input: ZipInputStream, remaining: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(BUFFER)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > remaining) refuse(ArchiveProblem.UNPACKED_TOO_LARGE)
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    private fun checkPath(name: String) {
        val path = name.trimEnd('/')
        val unsafe = path.isEmpty() || name.length > MAX_PATH || path.startsWith("/") || path.startsWith("\\") ||
            path.split('/').any { it == ".." || it == "." || it.isEmpty() } || !path.all { it in ALLOWED_PATH_CHARS } ||
            path.startsWith(RESERVED_PREFIX)
        if (unsafe) refuse(ArchiveProblem.UNSAFE_PATH, name)
    }

    private fun checkType(name: String) {
        val extension = name.substringAfterLast('/').substringAfterLast('.', "").lowercase()
        if (extension !in ALLOWED_EXTENSIONS) refuse(ArchiveProblem.FILE_TYPE_NOT_ALLOWED, name)
    }

    private fun looksLikeZip(zip: ByteArray) = zip.size >= MAGIC.size && MAGIC.indices.all { zip[it] == MAGIC[it] } ||
        zip.size >= EOCD_ONLY && zip[0] == 'P'.code.toByte() && zip[1] == 'K'.code.toByte() // an empty ZIP starts with the end record

    /**
     * Symbolic links are refused (S3.9): the central directory carries the Unix mode in the high 16 bits of the external
     * attributes of an entry made on Unix. Nothing is unpacked here, only the directory read.
     */
    private fun rejectLinks(zip: ByteArray) {
        val buffer = ByteBuffer.wrap(zip).order(ByteOrder.LITTLE_ENDIAN)
        val tail = (zip.size - EOCD_MIN downTo maxOf(0, zip.size - EOCD_MIN - MAX_COMMENT)).firstOrNull { buffer.getInt(it) == EOCD }
            ?: refuse(ArchiveProblem.NOT_A_ZIP)
        val count = buffer.getShort(tail + EOCD_ENTRIES).toInt() and MASK_16
        if (count > maxEntries) refuse(ArchiveProblem.TOO_MANY_ENTRIES)
        var at = buffer.getInt(tail + EOCD_OFFSET).toLong() and MASK_32
        repeat(count) {
            val position = at.toInt()
            val inside = at >= 0 && at + CENTRAL_FIXED <= zip.size && buffer.getInt(position) == CENTRAL
            if (!inside) refuse(ArchiveProblem.NOT_A_ZIP)
            val nameLength = buffer.getShort(position + NAME_LENGTH).toInt() and MASK_16
            if (isLink(buffer, position)) {
                val shown = minOf(nameLength, zip.size - position - CENTRAL_FIXED)
                refuse(ArchiveProblem.UNSAFE_PATH, String(zip, position + CENTRAL_FIXED, shown, Charsets.UTF_8))
            }
            val extraLength = buffer.getShort(position + EXTRA_LENGTH).toInt() and MASK_16
            val commentLength = buffer.getShort(position + COMMENT_LENGTH).toInt() and MASK_16
            at += CENTRAL_FIXED + nameLength + extraLength + commentLength
        }
    }

    /** The entry was made on Unix and its mode says "symbolic link". */
    private fun isLink(buffer: ByteBuffer, position: Int): Boolean {
        val madeByUnix = (buffer.getShort(position + MADE_BY).toInt() ushr BYTE_BITS) == UNIX
        val mode = buffer.getInt(position + EXTERNAL_ATTRIBUTES) ushr MODE_SHIFT
        return madeByUnix && (mode and FILE_TYPE_MASK) == SYMLINK
    }

    companion object {
        const val MAX_ENTRIES = 200
        const val MAX_UNPACKED_BYTES = 50L * 1024 * 1024
        private const val MAX_PATH = 255
        private const val BUFFER = 16 * 1024
        const val RESERVED_PREFIX = "__drawboard"
        private val ALLOWED_PATH_CHARS = ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('.', '_', '/', '-')

        /** The only file types of a plugin bundle (plugin API 1): no HTML, no SVG, no WebAssembly. */
        val ALLOWED_EXTENSIONS = setOf("js", "mjs", "css", "json", "png", "jpg", "jpeg", "gif", "webp", "woff2", "txt", "md")

        private val MAGIC = byteArrayOf('P'.code.toByte(), 'K'.code.toByte(), 3, 4)
        private const val EOCD_ONLY = 22
        private const val EOCD = 0x06054b50
        private const val CENTRAL = 0x02014b50
        private const val EOCD_MIN = 22
        private const val MAX_COMMENT = 65_535
        private const val EOCD_ENTRIES = 10
        private const val EOCD_OFFSET = 16
        private const val CENTRAL_FIXED = 46
        private const val MADE_BY = 4
        private const val NAME_LENGTH = 28
        private const val EXTRA_LENGTH = 30
        private const val COMMENT_LENGTH = 32
        private const val EXTERNAL_ATTRIBUTES = 38
        private const val MASK_16 = 0xFFFF
        private const val MASK_32 = 0xFFFFFFFFL
        private const val BYTE_BITS = 8
        private const val UNIX = 3
        private const val MODE_SHIFT = 16
        private const val FILE_TYPE_MASK = 0xF000
        private const val SYMLINK = 0xA000
    }
}
