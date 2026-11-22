package at.dergeorg.drawboard.plugins.domain.archive

import at.dergeorg.drawboard.plugins.domain.Zips
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import java.io.ByteArrayOutputStream
import java.lang.management.ManagementFactory
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PluginArchiveTest {

    private val archive = PluginArchive()

    private fun rejected(zip: ByteArray, archive: PluginArchive = this.archive): DomainException =
        assertFailsWith<DomainException>("must be rejected") { archive.unpack(zip) }

    private fun reason(error: DomainException) = error.params["reason"]

    /** One entry of [size] zero bytes, written in chunks: the test never holds the unpacked content itself. */
    private fun zeros(name: String, size: Int): ByteArray = ByteArrayOutputStream().also { bytes ->
        ZipOutputStream(bytes).use { zip ->
            zip.putNextEntry(ZipEntry(name))
            val chunk = ByteArray(CHUNK)
            repeat(size / CHUNK) { zip.write(chunk) }
            zip.write(chunk, 0, size % CHUNK)
            zip.closeEntry()
        }
    }.toByteArray()

    /** The heap bytes this thread allocates while [block] runs (HotSpot counts them per thread). */
    private fun allocatedBy(block: () -> Unit): Long {
        val threads = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assumeTrue(threads.isThreadAllocatedMemorySupported && threads.isThreadAllocatedMemoryEnabled, "allocation counter")
        archive.unpack(Zips.plugin()) // warm up: class loading must not count
        val before = threads.currentThreadAllocatedBytes
        block()
        return threads.currentThreadAllocatedBytes - before
    }

    @Nested
    inner class Memory {

        @Test
        fun `when an entry is larger than the limit then it is refused without allocating its size`() {
            val bomb = zeros("bomb.txt", 64 * MIB)
            var error: DomainException? = null

            val allocated = allocatedBy { error = rejected(bomb) }

            assertEquals("UNPACKED_TOO_LARGE", error?.let(::reason), "refused")
            assertTrue(allocated < 2 * MIB, "only counted, not held: $allocated bytes allocated for 64 MiB unpacked")
        }

        @Test
        fun `when an archive is accepted then each file is held once at its exact size - no doubling buffer`() {
            val zip = zeros("big.txt", 16 * MIB + 1)
            var held = 0

            val allocated = allocatedBy { held = archive.unpack(zip).files.getValue("big.txt").size }

            assertEquals(16 * MIB + 1, held, "size")
            assertTrue(allocated < 17 * MIB, "one array of 16 MiB and a little: $allocated bytes allocated")
        }
    }

    @Nested
    inner class Accepting {

        @Test
        fun `when the archive is a plugin then its files are held exactly as in the ZIP`() {
            val unpacked = archive.unpack(Zips.plugin(more = arrayOf("assets/logo.png" to byteArrayOf(1, 2, 3), "dir/" to ByteArray(0))))

            assertEquals(
                setOf("drawboard-plugin.json", "dist/index.js", "style.css", "assets/logo.png"),
                unpacked.files.keys,
                "directories are not files",
            )
            assertEquals(listOf<Byte>(1, 2, 3), unpacked.files.getValue("assets/logo.png").toList(), "bytes")
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(
            strings = [
                "a.js", "a.mjs", "a.css", "a.json", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.woff2", "a.txt", "a.md", "A.JS",
            ],
        )
        fun `when the file type is on the list then it is accepted`(name: String) {
            archive.unpack(Zips.zip(name to byteArrayOf(1)))
        }
    }

    @Nested
    inner class Refusing {

        @ParameterizedTest(name = "{0}")
        @ValueSource(
            strings = ["index.html", "page.htm", "logo.svg", "module.wasm", "run.sh", "x.exe", "noextension", "a.js.map", "x.JSX", "x.php"],
        )
        fun `when a file has a type that is not allowed then FILE_TYPE_NOT_ALLOWED names it - no html, no svg, no wasm`(name: String) {
            val error = rejected(Zips.zip("drawboard-plugin.json" to byteArrayOf(1), name to byteArrayOf(1)))

            assertEquals(ErrorCode.PLUGINS_ARCHIVE_INVALID, error.errorCode, "code")
            assertEquals("FILE_TYPE_NOT_ALLOWED" to name, reason(error) to error.params["path"], "reason and path")
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(
            strings = [
                "../evil.js", "a/../../evil.js", "/abs.js", "\\win.js", "C:/x.js", "a/./b.js", "a//b.js", "sp ace.js", "ümlaut.js",
                "__drawboard/x.js", "__drawboard.js", "a\\b.js",
            ],
        )
        fun `when a path is unsafe then UNSAFE_PATH - zip slip, absolute, windows, reserved`(name: String) {
            val error = rejected(Zips.zip(name to byteArrayOf(1)))

            assertEquals("UNSAFE_PATH", reason(error), "path $name")
        }

        @Test
        fun `when a name is used twice ignoring case then UNSAFE_PATH`() {
            val zip = ByteArrayOutputStream().also {
                ZipOutputStream(it).use { z ->
                    z.putNextEntry(ZipEntry("a.js")); z.write(1); z.closeEntry()
                    z.putNextEntry(ZipEntry("A.js")); z.write(2); z.closeEntry()
                }
            }.toByteArray()

            assertEquals("UNSAFE_PATH", reason(rejected(zip)), "duplicate")
        }

        @Test
        fun `when an entry is a symbolic link then UNSAFE_PATH`() {
            val zip = Zips.withSymlink(Zips.zip("link.js" to "../../etc/passwd".toByteArray(), "ok.js" to byteArrayOf(1)), "link.js")

            val error = rejected(zip)

            assertEquals("UNSAFE_PATH" to "link.js", reason(error) to error.params["path"], "link")
        }

        @Test
        fun `when there are more entries than allowed then TOO_MANY_ENTRIES`() {
            val entries = (1..201).map { "f$it.js" to byteArrayOf(1) }.toTypedArray()

            assertEquals("TOO_MANY_ENTRIES", reason(rejected(Zips.zip(*entries))), "201 entries")
            archive.unpack(Zips.zip(*(1..200).map { "f$it.js" to byteArrayOf(1) }.toTypedArray()))
        }

        @Test
        fun `when the unpacked size exceeds the limit then UNPACKED_TOO_LARGE - counted while unpacking, whatever the headers say`() {
            val small = PluginArchive(maxUnpackedBytes = 10_000)
            // 1 MB of zeros compresses to ~1 kB: a zip bomb in miniature
            val bomb = Zips.zip("bomb.txt" to ByteArray(1_000_000))

            assertTrue(bomb.size < 5_000, "the archive itself is tiny: ${bomb.size}")
            assertEquals("UNPACKED_TOO_LARGE", reason(rejected(bomb, small)), "inflated size counts")
            small.unpack(Zips.zip("ok.txt" to ByteArray(9_000)))
        }

        @Test
        fun `when the size is spread over many entries then the total counts`() {
            val small = PluginArchive(maxUnpackedBytes = 10_000)
            val zip = Zips.zip(*(1..5).map { "f$it.txt" to ByteArray(3_000) }.toTypedArray())

            assertEquals("UNPACKED_TOO_LARGE", reason(rejected(zip, small)), "5 x 3000 > 10000")
        }

        @Test
        fun `when a directory entry carries data then that data counts too - it is inflated even though it is not kept`() {
            val small = PluginArchive(maxUnpackedBytes = 10_000)

            assertEquals("UNPACKED_TOO_LARGE", reason(rejected(zeros("d/", 1_000_000), small)), "data behind d/")
        }

        @Test
        fun `when the ZIP is cut off inside a local header then NOT_A_ZIP - not an internal error`() {
            // a local header that announces a 64-byte name, 3 bytes of it, and an empty end record: 55 bytes
            val header = ByteArray(LOCAL_HEADER).also {
                byteArrayOf('P'.code.toByte(), 'K'.code.toByte(), 3, 4).copyInto(it)
                it[NAME_LENGTH_AT] = NAME_LENGTH
            }
            val end = ByteArray(END_RECORD).also { byteArrayOf('P'.code.toByte(), 'K'.code.toByte(), 5, 6).copyInto(it) }
            val cut = header + "abc".toByteArray() + end

            assertEquals(55, cut.size, "size")
            assertEquals("NOT_A_ZIP", reason(rejected(cut)), "cut header")
        }

        @ParameterizedTest(name = "{0}")
        @ValueSource(strings = ["", "not a zip at all", "PK"])
        fun `when the bytes are no ZIP then NOT_A_ZIP`(text: String) {
            assertEquals("NOT_A_ZIP", reason(rejected(text.toByteArray())), "bytes '$text'")
        }

        @Test
        fun `when the ZIP is empty or cut off then NOT_A_ZIP`() {
            val whole = Zips.plugin()

            assertEquals(
                "NOT_A_ZIP",
                reason(rejected(ByteArrayOutputStream().also { ZipOutputStream(it).close() }.toByteArray())),
                "no entries",
            )
            assertEquals("NOT_A_ZIP", reason(rejected(whole.copyOf(whole.size / 2))), "truncated")
        }
    }

    private companion object {
        const val MIB = 1024 * 1024
        const val CHUNK = 64 * 1024
        const val LOCAL_HEADER = 30
        const val END_RECORD = 22
        const val NAME_LENGTH_AT = 26
        const val NAME_LENGTH: Byte = 64
    }
}
