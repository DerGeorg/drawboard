package at.dergeorg.drawboard.files.domain.files.requires

import at.dergeorg.drawboard.files.domain.files.requires.impl.FilesystemFileStorage
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.uuid.Uuid

class FilesystemFileStorageTest {

    @TempDir
    lateinit var root: Path

    private val storage by lazy { FilesystemFileStorage(root.toString()) }
    private val key = BlobKey(Uuid.parse("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f"), BlobKind.ORIGINAL)

    private fun readAll(key: BlobKey): ByteArray? = storage.open(key)?.use { channel ->
        val buffer = ByteBuffer.allocate(channel.size().toInt())
        while (buffer.hasRemaining() && channel.read(buffer) >= 0) Unit
        buffer.array()
    }

    @Nested
    inner class Writing {

        @Test
        fun `when writing a blob then it lies under the id and its first digits - no client name reaches a path`() = runTest {
            val size = storage.write(key, flow { emit(byteArrayOf(1, 2)); emit(byteArrayOf(3)) })

            assertEquals(3L, size, "size")
            assertTrue(Files.exists(root.resolve("01").resolve("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f")), "layout")
            assertEquals(listOf<Byte>(1, 2, 3), readAll(key)?.toList(), "content")
        }

        @Test
        fun `when the other kinds are written then they get their own suffix`() = runTest {
            storage.write(BlobKey(key.fileId, BlobKind.THUMBNAIL), flow { emit(byteArrayOf(1)) })
            storage.write(BlobKey(key.fileId, BlobKind.PDF), flow { emit(byteArrayOf(2)) })

            val names = Files.list(root.resolve("01")).use { files -> files.map { it.fileName.toString() }.toList().sorted() }
            assertEquals(
                listOf("0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f.pdf", "0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f.thumbnail"),
                names,
                "suffixes",
            )
        }

        @Test
        fun `when the content fails half way then nothing is left behind - neither a blob nor a temp file`() = runTest {
            assertFailsWith<IllegalStateException>("the producer fails") {
                storage.write(key, flow { emit(byteArrayOf(1, 2, 3)); error("cap exceeded") })
            }

            assertNull(storage.size(key), "no blob")
            assertEquals(0, Files.list(root.resolve(".tmp")).use { it.count() }, "no temp file")
        }

        @Test
        fun `when a blob is written again then it is replaced atomically`() = runTest {
            storage.write(key, flow { emit(byteArrayOf(1, 2, 3)) })
            storage.write(key, flow { emit(byteArrayOf(9)) })

            assertEquals(listOf<Byte>(9), readAll(key)?.toList(), "replaced")
        }
    }

    @Nested
    inner class Managing {

        @Test
        fun `when a blob does not exist then size and open say so`() = runTest {
            assertNull(storage.size(key), "size")
            assertNull(storage.open(key), "open")
        }

        @Test
        fun `when moving and deleting then the blobs follow, and deleting a missing blob is fine`() = runTest {
            val staging = BlobKey(key.fileId, BlobKind.STAGING)
            storage.write(staging, flow { emit(byteArrayOf(5)) })
            storage.move(staging, key)

            assertEquals(listOf<Byte>(5), readAll(key)?.toList(), "moved over")
            assertNull(storage.size(staging), "source gone")
            storage.delete(key)
            storage.delete(key)
            assertNull(storage.size(key), "deleted")
        }

        @Test
        fun `when listing then every blob is reported with its key and age, and stray files are ignored`() = runTest {
            storage.write(key, flow { emit(byteArrayOf(1)) })
            storage.write(BlobKey(key.fileId, BlobKind.PDF), flow { emit(byteArrayOf(1)) })
            Files.writeString(root.resolve("01").resolve("not-a-blob.txt"), "x")

            val found = storage.list().toList()

            assertEquals(
                setOf(BlobKey(key.fileId, BlobKind.ORIGINAL), BlobKey(key.fileId, BlobKind.PDF)),
                found.map { it.key }.toSet(),
                "keys",
            )
            assertTrue(found.all { Clock.System.now() - it.modifiedAt < kotlin.time.Duration.parse("1m") }, "fresh")
        }

        @Test
        fun `when unfinished writes are old then they are purged`() = runTest {
            storage.size(key) // creates the directories
            val stale = Files.createTempFile(root.resolve(".tmp"), "upload-", ".part")

            storage.purgeUnfinished(Clock.System.now() + kotlin.time.Duration.parse("1h"))

            assertTrue(!Files.exists(stale), "removed")
        }
    }
}
