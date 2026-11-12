package at.dergeorg.drawboard.files.domain.files.requires.impl

import at.dergeorg.drawboard.files.domain.files.requires.BlobInfo
import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.BlobKind
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.channels.SeekableByteChannel
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * The files on a directory (a volume, `DRAWBOARD_FILES_DIR`). A blob is stored under the file's UUID, never under its
 * name: `<root>/<first two hex digits>/<uuid>` for the original, with `.thumbnail` / `.pdf` / `.staging` appended for the
 * other kinds. Everything in a path comes from a [Uuid] and a [BlobKind] - no client input ever reaches a path, so there
 * is nothing to traverse. Writes go to `<root>/.tmp` first and are moved into place atomically.
 */
@Component
internal class FilesystemFileStorage(@Value("\${files.dir}") directory: String) : FileStorage {

    private val root: Path = Path.of(directory).toAbsolutePath().normalize()
    private val temporary: Path = this.root.resolve(TMP)

    init {
        Files.createDirectories(temporary)
    }

    @WithSpan
    override suspend fun write(key: BlobKey, content: Flow<ByteArray>): Long {
        val target = pathOf(key)
        val temp = withContext(Dispatchers.IO) { Files.createTempFile(temporary, "upload-", ".part") }
        try {
            var written = 0L
            withContext(Dispatchers.IO) { FileChannel.open(temp, StandardOpenOption.WRITE) }.use { channel ->
                content.collect { chunk ->
                    withContext(Dispatchers.IO) {
                        val buffer = ByteBuffer.wrap(chunk)
                        while (buffer.hasRemaining()) channel.write(buffer)
                    }
                    written += chunk.size
                }
            }
            withContext(Dispatchers.IO) {
                Files.createDirectories(target.parent)
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }
            return written
        } catch (@Suppress("TooGenericExceptionCaught") e: Throwable) {
            withContext(NonCancellable + Dispatchers.IO) { Files.deleteIfExists(temp) }
            throw e
        }
    }

    override fun open(key: BlobKey): SeekableByteChannel? = try {
        FileChannel.open(pathOf(key), StandardOpenOption.READ)
    } catch (_: NoSuchFileException) {
        null
    }

    @WithSpan
    override suspend fun size(key: BlobKey): Long? = withContext(Dispatchers.IO) {
        try {
            Files.size(pathOf(key))
        } catch (_: NoSuchFileException) {
            null
        }
    }

    @WithSpan
    override suspend fun delete(key: BlobKey) {
        withContext(Dispatchers.IO) { Files.deleteIfExists(pathOf(key)) }
    }

    @WithSpan
    override suspend fun move(from: BlobKey, to: BlobKey) {
        withContext(Dispatchers.IO) {
            Files.move(pathOf(from), pathOf(to), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    override fun list(): Flow<BlobInfo> = flow {
        val found = ArrayList<BlobInfo>()
        Files.newDirectoryStream(root) { it.fileName.toString().length == SHARD && Files.isDirectory(it) }.use { shards ->
            for (shard in shards) {
                Files.newDirectoryStream(shard).use { blobs ->
                    for (blob in blobs) keyOf(blob.fileName.toString())?.let {
                        found += BlobInfo(it, Instant.fromEpochMilliseconds(Files.getLastModifiedTime(blob).toMillis()))
                    }
                }
            }
        }
        found.forEach { emit(it) }
    }.flowOn(Dispatchers.IO)

    override suspend fun purgeUnfinished(before: Instant) {
        withContext(Dispatchers.IO) {
            Files.newDirectoryStream(temporary).use { parts ->
                for (part in parts) {
                    if (Files.getLastModifiedTime(part).toMillis() < before.toEpochMilliseconds()) {
                        try {
                            Files.deleteIfExists(part)
                        } catch (_: IOException) {
                            // still in use or already gone: the next sweep tries again
                        }
                    }
                }
            }
        }
    }

    private fun pathOf(key: BlobKey): Path {
        val id = key.fileId.toHexDashString()
        val suffix = when (key.kind) {
            BlobKind.ORIGINAL -> ""
            BlobKind.THUMBNAIL -> ".thumbnail"
            BlobKind.PDF -> ".pdf"
            BlobKind.STAGING -> ".staging"
        }
        return root.resolve(id.substring(0, SHARD)).resolve(id + suffix)
    }

    private fun keyOf(fileName: String): BlobKey? {
        val id = fileName.take(UUID_LENGTH)
        val kind = when (fileName.drop(UUID_LENGTH)) {
            "" -> BlobKind.ORIGINAL
            ".thumbnail" -> BlobKind.THUMBNAIL
            ".pdf" -> BlobKind.PDF
            ".staging" -> BlobKind.STAGING
            else -> return null
        }
        return try {
            BlobKey(Uuid.parse(id), kind)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private companion object {
        const val TMP = ".tmp"
        const val SHARD = 2
        const val UUID_LENGTH = 36
    }
}
