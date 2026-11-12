package at.dergeorg.drawboard.files.domain.files

import at.dergeorg.drawboard.files.domain.detect.AllowedType
import at.dergeorg.drawboard.files.domain.detect.FileTypes
import at.dergeorg.drawboard.files.domain.files.model.FileKind
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * Looks at an upload while it streams past, chunk by chunk, so a violation stops it as soon as it is known and nothing
 * beyond the cap is ever written (S4.1, S4.2): the cap does not depend on `Content-Length`, which a client can lie
 * about. Until the first [FileTypes.HEAD_BYTES] have arrived nothing is known and the file is small; then the head is
 * run through the detector. Not thread-safe - one upload, one inspector, one coroutine.
 *
 * Throws (and so aborts the write): `FILES_TYPE_NOT_ALLOWED` (415) for a type outside the allowlist or an extension that
 * does not match, `PAYLOAD_TOO_LARGE` (413) above the cap of the kind, `FILES_QUOTA_EXCEEDED` (413) above what the user or
 * the board may still store.
 */
internal class UploadInspector(
    private val fileName: String,
    private val limits: FilesLimits,
    private val userRemaining: Long,
    private val boardRemaining: Long,
) {
    private val head = ByteArrayOutputStream()
    private val digest = MessageDigest.getInstance("SHA-256")
    private var total = 0L
    private var cap = limits.maxFileBytes

    /** The detected allowlisted type once known; null for a ZIP (decided after the write) and before the head is complete. */
    var type: AllowedType? = null
        private set

    /** True for an Office file in a ZIP container: its type needs the whole file ([ZipSniffer][at.dergeorg.drawboard.files.domain.detect.ZipSniffer]). */
    var isZip: Boolean = false
        private set

    private var decided = false

    val size: Long get() = total

    /** The first bytes of the file, at most [FileTypes.HEAD_BYTES]. */
    fun head(): ByteArray = head.toByteArray()

    fun sha256(): String = digest.digest().joinToString("") { "%02x".format(it) }

    fun accept(chunk: ByteArray) {
        total += chunk.size
        digest.update(chunk)
        if (head.size() < FileTypes.HEAD_BYTES) head.write(chunk, 0, minOf(chunk.size, FileTypes.HEAD_BYTES - head.size()))
        if (!decided && head.size() >= FileTypes.HEAD_BYTES) decide()
        enforce()
    }

    /** At the end of the stream: a file shorter than the head is decided now. */
    fun finish() {
        if (!decided) decide()
        enforce()
    }

    private fun decide() {
        decided = true
        when (val detection = FileTypes.detect(head.toByteArray())) {
            is FileTypes.Detection.Known -> {
                if (!FileTypes.extensionMatches(fileName, detection.type)) throw FilesErrors.typeNotAllowed(detection.type.mediaType)
                type = detection.type
                if (detection.type.kind == FileKind.VIDEO) cap = limits.maxVideoBytes
            }
            FileTypes.Detection.Zip -> isZip = true
            is FileTypes.Detection.Other -> throw FilesErrors.typeNotAllowed(detection.mediaType)
        }
    }

    private fun enforce() {
        if (total > cap) throw PayloadTooLargeException(cap)
        if (total > userRemaining) throw FilesErrors.quota("USER", limits.maxBytesPerUser)
        if (total > boardRemaining) throw FilesErrors.quota("BOARD", limits.maxBytesPerBoard)
    }
}
