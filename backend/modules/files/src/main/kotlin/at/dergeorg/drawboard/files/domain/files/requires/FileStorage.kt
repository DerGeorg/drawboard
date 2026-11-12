package at.dergeorg.drawboard.files.domain.files.requires

import kotlinx.coroutines.flow.Flow
import java.nio.channels.SeekableByteChannel
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** What a stored blob is: the original, or something made from it. The stored name is the file id plus this - never the file name. */
internal enum class BlobKind { ORIGINAL, THUMBNAIL, PDF, STAGING }

/** Address of a blob. */
internal data class BlobKey(val fileId: Uuid, val kind: BlobKind)

/** A blob found by [FileStorage.list] - for the orphan sweep. */
internal data class BlobInfo(val key: BlobKey, val modifiedAt: Instant)

/**
 * Port: where the bytes are kept. Today a directory on a volume ([at.dergeorg.drawboard.files.domain.files.requires.impl.FilesystemFileStorage]);
 * an S3-compatible adapter can implement it later (S3.6 of the concept) - nothing outside the adapter knows a path.
 */
internal interface FileStorage {

    /**
     * Stores [content] under [key] (replacing what is there) and returns the number of bytes. The write is atomic: a
     * reader never sees half a blob, and when [content] fails (cap exceeded, connection lost) nothing remains.
     */
    suspend fun write(key: BlobKey, content: Flow<ByteArray>): Long

    /**
     * A channel to read the blob (positioned at 0); closed by the caller. Null if there is no such blob. Opening is cheap but
     * reading BLOCKS: callers read on the I/O dispatcher (the web layer hands the channel to Spring, which does the same).
     */
    fun open(key: BlobKey): SeekableByteChannel?

    suspend fun size(key: BlobKey): Long?

    /** Deletes the blob; nothing happens if there is none. */
    suspend fun delete(key: BlobKey)

    /** Moves [from] over [to] (replacing it). */
    suspend fun move(from: BlobKey, to: BlobKey)

    /** Every blob that is stored (the orphan sweep walks them). */
    fun list(): Flow<BlobInfo>

    /** Removes what an interrupted write left behind that is older than [before]. */
    suspend fun purgeUnfinished(before: Instant)
}
