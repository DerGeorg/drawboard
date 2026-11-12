package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.files.domain.files.requires.BlobKey
import at.dergeorg.drawboard.files.domain.files.requires.FileStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer

private const val CHUNK = 64 * 1024

/** [length] bytes from [from] (fewer at the end of the blob); empty if there is no such blob. */
internal suspend fun FileStorage.readRange(key: BlobKey, from: Long, length: Int): ByteArray {
    return withContext(Dispatchers.IO) {
        val channel = open(key) ?: return@withContext ByteArray(0)
        channel.use {
            it.position(from)
            val buffer = ByteBuffer.allocate(length)
            while (buffer.hasRemaining() && it.read(buffer) >= 0) Unit
            buffer.array().copyOf(buffer.position())
        }
    }
}

/** The blob from [from] to its end as chunks of 64 KiB, read on the I/O dispatcher. Empty if there is no such blob. */
internal fun FileStorage.chunks(key: BlobKey, from: Long = 0): Flow<ByteArray> = flow {
    val channel = open(key) ?: return@flow
    channel.use {
        it.position(from)
        var last = false
        while (!last) {
            val buffer = ByteBuffer.allocate(CHUNK)
            while (buffer.hasRemaining() && it.read(buffer) >= 0) Unit
            last = buffer.hasRemaining() // the end of the blob came before the buffer was full
            if (buffer.position() > 0) emit(buffer.array().copyOf(buffer.position()))
        }
    }
}.flowOn(Dispatchers.IO)
