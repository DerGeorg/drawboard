package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.files.domain.files.model.Conversion
import at.dergeorg.drawboard.files.domain.files.model.StoredFile
import at.dergeorg.drawboard.files.domain.files.requires.BlobInfo
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.Converter
import at.dergeorg.drawboard.files.domain.files.requires.FileRepository
import at.dergeorg.drawboard.files.domain.files.requires.FilesMetrics
import at.dergeorg.drawboard.files.domain.files.requires.FileScanner
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import at.dergeorg.drawboard.files.domain.files.requires.ScanVerdict
import at.dergeorg.drawboard.files.domain.files.requires.Transactions
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.channels.SeekableByteChannel
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.imageio.ImageIO
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fake of the [FileScanner] port: answers [verdict] and keeps what it was asked to scan. */
internal class FakeFileScanner(var verdict: ScanVerdict = ScanVerdict.Clean, override val enabled: Boolean = true) : FileScanner {
    val scanned = mutableListOf<ByteArray>()

    override suspend fun scan(content: java.nio.channels.ReadableByteChannel, size: Long): ScanVerdict {
        val bytes = java.io.ByteArrayOutputStream()
        java.nio.channels.Channels.newInputStream(content).copyTo(bytes)
        scanned += bytes.toByteArray()
        return verdict
    }
}

/** Fake of the [FilesMetrics] port: keeps what was reported, in order. */
internal class RecordingFilesMetrics : FilesMetrics {
    val uploads = mutableListOf<String>()
    val conversions = mutableListOf<String>()
    val scans = mutableListOf<String>()

    override fun upload(result: String) {
        uploads += result
    }

    override fun scan(result: String) {
        scans += result
    }

    override fun conversion(result: String) {
        conversions += result
    }
}

/** Fake of the [FileRepository] port: keeps the rows in memory, with the same version rules as the real one. */
internal class InMemoryFileRepository : FileRepository {
    val rows = linkedMapOf<Uuid, StoredFile>()

    override suspend fun findById(id: Uuid) = rows[id]

    override suspend fun findByBoard(boardId: Uuid) =
        rows.values.filter { it.boardId == boardId }.sortedWith(compareByDescending<StoredFile> { it.createdAt }.thenByDescending { it.id })

    override suspend fun findByBoards(boardIds: Collection<Uuid>) = rows.values.filter { it.boardId in boardIds }

    override suspend fun findByConversion(state: Conversion) = rows.values.filter { it.conversion == state }

    override suspend fun countByBoard(boardId: Uuid) = rows.values.count { it.boardId == boardId }.toLong()

    override suspend fun usedBytesOfBoard(boardId: Uuid) =
        rows.values.filter { it.boardId == boardId }.sumOf { it.size + (it.pdfSize ?: 0) }

    override suspend fun usedBytesOfUser(userId: Uuid) =
        rows.values.filter { it.createdBy == userId }.sumOf { it.size + (it.pdfSize ?: 0) }

    override suspend fun totalBytes() = rows.values.sumOf { it.size + (it.pdfSize ?: 0) }

    override suspend fun insert(file: StoredFile): StoredFile {
        check(file.version == null) { "a new row has no version" }
        return file.copy(version = 0).also { rows[it.id] = it }
    }

    override suspend fun update(file: StoredFile): StoredFile? {
        val current = rows[file.id] ?: return null
        if (current.version != file.version) return null
        return file.copy(version = current.version!! + 1).also { rows[it.id] = it }
    }

    override suspend fun existing(ids: Collection<Uuid>) = ids.filter { it in rows }.toSet()

    override suspend fun deleteByIds(ids: Collection<Uuid>) {
        ids.forEach { rows.remove(it) }
    }
}

/** Fake of the [FileStorage] port: the blobs in memory. A flow that fails leaves nothing behind, like the real write. */
internal class InMemoryFileStorage : FileStorage {
    val blobs = linkedMapOf<BlobKey, ByteArray>()
    val modified = mutableMapOf<BlobKey, Instant>()
    var now: Instant = Instant.parse("2026-11-10T08:00:00Z")

    override suspend fun write(key: BlobKey, content: Flow<ByteArray>): Long {
        val out = ByteArrayOutputStream()
        content.collect { out.write(it) }
        blobs[key] = out.toByteArray()
        modified[key] = now
        return out.size().toLong()
    }

    /** When set, the next [open] finds nothing (the scan opens first), as if the blob had vanished between the write and the scan. */
    var nextOpenFindsNothing = false

    override fun open(key: BlobKey): SeekableByteChannel? {
        if (nextOpenFindsNothing) {
            nextOpenFindsNothing = false
            return null
        }
        return blobs[key]?.let { BytesChannel(it) }
    }

    override suspend fun size(key: BlobKey) = blobs[key]?.size?.toLong()

    override suspend fun delete(key: BlobKey) {
        blobs.remove(key)
        modified.remove(key)
    }

    override suspend fun move(from: BlobKey, to: BlobKey) {
        blobs[to] = checkNotNull(blobs.remove(from))
        modified[to] = now
        modified.remove(from)
    }

    override fun list(): Flow<BlobInfo> = blobs.keys.map { BlobInfo(it, modified.getValue(it)) }.asFlow()

    override suspend fun purgeUnfinished(before: Instant) = Unit
}

internal class BytesChannel(private val bytes: ByteArray) : SeekableByteChannel {
    private var position = 0L
    private var open = true

    override fun read(dst: ByteBuffer): Int {
        if (position >= bytes.size) return -1
        val n = minOf(dst.remaining(), bytes.size - position.toInt())
        dst.put(bytes, position.toInt(), n)
        position += n
        return n
    }

    override fun write(src: ByteBuffer): Int = throw UnsupportedOperationException()
    override fun position() = position
    override fun position(newPosition: Long) = apply { position = newPosition }
    override fun size() = bytes.size.toLong()
    override fun truncate(size: Long) = throw UnsupportedOperationException()
    override fun isOpen() = open
    override fun close() {
        open = false
    }
}

internal object DirectTransactions : Transactions {
    override suspend fun <T> required(block: suspend () -> T): T = block()
}

/** A converter the test steers: it answers [result] (or throws), after [delayMillis]. */
internal class FakeConverter(var result: () -> Flow<ByteArray> = { flow { emit(PDF_BYTES) } }) : Converter {
    val calls = mutableListOf<Pair<String, ByteArray>>()

    override fun toPdf(extension: String, source: Flow<ByteArray>): Flow<ByteArray> = flow {
        val received = ByteArrayOutputStream()
        source.collect { received.write(it) }
        calls += extension to received.toByteArray()
        emitAll(result())
    }

    companion object {
        val PDF_BYTES = "%PDF-1.7\n%fake pdf for a test\n".toByteArray()
    }
}

/** Real files as bytes, made by the JDK or by hand - the detector reads magic bytes, so they are the real thing. */
internal object Samples {

    fun png(width: Int = 4, height: Int = 3, alpha: Boolean = false): ByteArray = image("png", width, height, alpha)

    fun jpeg(width: Int = 4, height: Int = 3): ByteArray = image("jpg", width, height, alpha = false)

    fun gif(width: Int = 4, height: Int = 3): ByteArray = image("gif", width, height, alpha = false)

    /** A progressive JPEG (frame header SOF2). [noisy] makes the file large: random pixels do not compress. */
    fun progressiveJpeg(width: Int = 64, height: Int = 48, noisy: Boolean = false): ByteArray {
        val image = noisyOrPlain(width, height, noisy)
        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        val out = ByteArrayOutputStream()
        try {
            ImageIO.createImageOutputStream(out).use { stream ->
                writer.output = stream
                val params = writer.defaultWriteParam.apply {
                    progressiveMode = javax.imageio.ImageWriteParam.MODE_DEFAULT
                    compressionMode = javax.imageio.ImageWriteParam.MODE_EXPLICIT
                    compressionQuality = 0.9f
                }
                writer.write(null, javax.imageio.IIOImage(image, null, null), params)
            }
        } finally {
            writer.dispose()
        }
        return out.toByteArray()
    }

    /** A baseline JPEG of random pixels, big enough that a read of it can be told from a chunked one. */
    fun noisyJpeg(width: Int, height: Int): ByteArray =
        ByteArrayOutputStream().also { ImageIO.write(noisyOrPlain(width, height, noisy = true), "jpg", it) }.toByteArray()

    private fun noisyOrPlain(width: Int, height: Int, noisy: Boolean): BufferedImage {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val random = java.util.Random(SEED)
        for (x in 0 until width) for (y in 0 until height) {
            image.setRGB(x, y, if (noisy) random.nextInt(RGB_RANGE) else (x * 40 shl 16) or (y * 60 shl 8) or 0x80)
        }
        return image
    }

    private const val SEED = 42L
    private const val RGB_RANGE = 0x1000000

    private fun image(format: String, width: Int, height: Int, alpha: Boolean): ByteArray {
        val image = BufferedImage(width, height, if (alpha) BufferedImage.TYPE_INT_ARGB else BufferedImage.TYPE_INT_RGB)
        for (x in 0 until width) for (y in 0 until height) image.setRGB(x, y, (x * 40 shl 16) or (y * 60 shl 8) or 0x80)
        return ByteArrayOutputStream().also { ImageIO.write(image, format, it) }.toByteArray()
    }

    fun pdf(): ByteArray = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n".toByteArray()

    /** A WebP: RIFF container, lossy VP8 chunk with a frame header of [width] x [height]. */
    fun webp(width: Int = 8, height: Int = 6): ByteArray {
        val payload = ByteBuffer.allocate(10 + 8).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        payload.put(byteArrayOf(0x10, 0x02, 0x00, 0x9d.toByte(), 0x01, 0x2a)).putShort(width.toShort()).putShort(height.toShort())
        payload.put(ByteArray(8))
        val chunk = "VP8 ".toByteArray() + le32(payload.capacity()) + payload.array()
        return "RIFF".toByteArray() + le32(4 + chunk.size) + "WEBP".toByteArray() + chunk
    }

    /** A MP4 file start: an `ftyp` box with the brand `isom`, padded to [size] bytes. */
    fun mp4(size: Int = 64): ByteArray {
        val ftyp = byteArrayOf(0, 0, 0, 0x18) + "ftypisom".toByteArray() + byteArrayOf(0, 0, 2, 0) + "isomiso2".toByteArray()
        return ftyp + ByteArray((size - ftyp.size).coerceAtLeast(0))
    }

    /** The start of a WebM file: the EBML header with DocType "webm". */
    fun webm(): ByteArray = ints(
        0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 1, 0x42, 0xF7, 0x81, 1,
        0x42, 0xF2, 0x81, 4, 0x42, 0xF3, 0x81, 8, 0x42, 0x82, 0x84,
    ) + "webm".toByteArray() + ByteArray(32)

    private fun ints(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    /** [png] with the width and height of its IHDR chunk replaced: only the header is changed, the data is not a real image of that size. */
    fun withPngSize(png: ByteArray, width: Int, height: Int): ByteArray {
        val copy = png.copyOf()
        listOf(PNG_WIDTH_AT to width, PNG_HEIGHT_AT to height).forEach { (at, value) ->
            (0..3).forEach { copy[at + it] = (value shr (24 - 8 * it)).toByte() }
        }
        return copy
    }

    private const val PNG_WIDTH_AT = 16
    private const val PNG_HEIGHT_AT = 20

    /** A QuickTime movie (`ftyp qt  `): the same container family as MP4, but not on the allowlist. */
    fun quicktime(): ByteArray = byteArrayOf(0, 0, 0, 0x14) + "ftypqt  ".toByteArray() + ByteArray(32)

    fun svg(): ByteArray = """<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>""".toByteArray()

    fun exe(): ByteArray = byteArrayOf('M'.code.toByte(), 'Z'.code.toByte(), 0x90.toByte(), 0, 3, 0, 0, 0, 4, 0, 0, 0) + ByteArray(64)

    /** A ZIP as Office Open XML: only the entry names matter to the detector, the content is nonsense. */
    fun ooxml(main: String): ByteArray = zip("[Content_Types].xml" to "<Types/>", "_rels/.rels" to "<Relationships/>", main to "<x/>")

    /** An OpenDocument file: the first entry is the STORED `mimetype`. */
    fun odf(mediaType: String): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            val bytes = mediaType.toByteArray()
            val entry = ZipEntry("mimetype").apply {
                method = ZipEntry.STORED
                size = bytes.size.toLong()
                compressedSize = bytes.size.toLong()
                crc = java.util.zip.CRC32().also { it.update(bytes) }.value
            }
            zip.putNextEntry(entry)
            zip.write(bytes)
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("content.xml"))
            zip.write("<office/>".toByteArray())
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    fun zip(vararg entries: Pair<String, String>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { (name, content) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(content.toByteArray())
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun le32(value: Int) = byteArrayOf(value.toByte(), (value shr 8).toByte(), (value shr 16).toByte(), (value shr 24).toByte())
}

/** An upload as chunks of [chunk] bytes, the way the web layer delivers it. */
internal fun ByteArray.asUpload(chunk: Int = 1024): Flow<ByteArray> = asList().chunked(chunk).map { it.toByteArray() }.asFlow()
