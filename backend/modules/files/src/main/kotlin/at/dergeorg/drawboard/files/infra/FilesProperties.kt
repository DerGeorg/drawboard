package at.dergeorg.drawboard.files.infra

import at.dergeorg.drawboard.files.domain.files.FilesLimits
import at.dergeorg.drawboard.files.domain.urls.FileUrlSigner
import org.springframework.boot.context.properties.ConfigurationProperties
import java.nio.file.Files
import java.nio.file.Path

/**
 * Settings of the file storage, bound from `files.*` (environment variables in application.yaml).
 *
 * @param dir `DRAWBOARD_FILES_DIR`, REQUIRED: the directory the files are stored in (a volume; the container's root
 *   file system is read-only). Stored names are UUIDs.
 * @param urlKeys `DRAWBOARD_FILE_URL_KEYS`: the keys that sign the file URLs, comma separated, each base64 of at least
 *   32 random bytes. The FIRST signs, ALL verify (S4.4). Rotation: put the new key first, drop the old one after an hour.
 * @param urlKeysFile `DRAWBOARD_FILE_URL_KEYS_FILE`: the same list in a file (Docker/Kubernetes secret); wins over [urlKeys].
 * @param gotenbergUrl `DRAWBOARD_GOTENBERG_URL`: base URL of the Gotenberg sidecar (S4.10), e.g. `http://gotenberg:3000`.
 *   Without it Office documents are stored but their conversion fails at once (`conversion: FAILED`).
 * @param filesOrigin `DRAWBOARD_FILES_ORIGIN`: set when the deployment serves files from an origin of their own
 *   (S4.6); then `Cross-Origin-Resource-Policy` is `same-site` instead of `same-origin`.
 * @param maxFileBytes largest image / PDF / Office file (S4.1), [maxVideoBytes] the largest video.
 * @param maxBytesPerUser / [maxBytesPerBoard] storage quotas over the originals; [maxFilesPerBoard] files per board.
 * @param uploadsPerMinute / [uploadBytesPerMinute] the rate limit and byte budget per user (S7.3).
 * @param conversionsPerMinute conversions per user and minute (S4.10); [conversionTimeoutSeconds] the time one conversion gets.
 * @param decodeThreads / [decodeTimeoutSeconds] the bounded pool image thumbnails are made in, and how long one may take (S4.8).
 * @param clamavHost `DRAWBOARD_CLAMAV_HOST` (S4.12): the clamd that scans every upload before the file becomes visible. Without it
 *   nothing is scanned (the no-op scanner). [clamavPort] `DRAWBOARD_CLAMAV_PORT` (3310). The adapter reads these through `@Value`,
 *   the fields are here for the documentation and the checks.
 * @param clamavMaxBytes `DRAWBOARD_CLAMAV_MAX_BYTES`: the largest file sent to clamd (default 25 MiB, clamd's own `StreamMaxLength`);
 *   a larger one is not sent: fail closed refuses it with 413 (`limit` = this value), fail open accepts it. With fail closed it must be at
 *   least [maxVideoBytes] (a warning at start says so), and so must clamd's `StreamMaxLength`, `MaxFileSize` and `MaxScanSize`. [clamavTimeoutSeconds] `DRAWBOARD_CLAMAV_TIMEOUT_SECONDS`
 *   is the time one whole scan gets, [clamavConnectTimeoutSeconds] the time to connect.
 * @param clamavFailClosed `DRAWBOARD_CLAMAV_FAIL_CLOSED`: what happens when the scanner is down or cannot decide - false (default)
 *   accepts the upload and counts it (`drawboard.scans{result="unavailable"}`), true refuses it (503 with `Retry-After`).
 * @param orphanGraceSeconds / [sweepIntervalSeconds] the daily sweep for stored blobs without metadata (S4.13): a blob younger
 *   than the grace period may belong to an upload that is still running.
 */
@ConfigurationProperties("files")
internal data class FilesProperties(
    val dir: String,
    val urlKeys: String? = null,
    val urlKeysFile: String? = null,
    val gotenbergUrl: String? = null,
    val filesOrigin: String? = null,
    val maxFileBytes: Long = DEFAULTS.maxFileBytes,
    val maxVideoBytes: Long = DEFAULTS.maxVideoBytes,
    val maxBytesPerUser: Long = DEFAULTS.maxBytesPerUser,
    val maxBytesPerBoard: Long = DEFAULTS.maxBytesPerBoard,
    val maxFilesPerBoard: Int = DEFAULTS.maxFilesPerBoard,
    val uploadsPerMinute: Int = DEFAULTS.uploadsPerMinute,
    val uploadBytesPerMinute: Long = DEFAULTS.uploadBytesPerMinute,
    val conversionsPerMinute: Int = DEFAULTS.conversionsPerMinute,
    val conversionTimeoutSeconds: Long = DEFAULTS.conversionTimeout.inWholeSeconds,
    val conversionQueue: Int = DEFAULTS.conversionQueue,
    val decodeThreads: Int = DEFAULT_DECODE_THREADS,
    val decodeTimeoutSeconds: Long = DEFAULT_DECODE_SECONDS,
    val clamavHost: String? = null,
    val clamavPort: Int = DEFAULT_CLAMAV_PORT,
    val clamavMaxBytes: Long = DEFAULT_CLAMAV_MAX_BYTES,
    val clamavTimeoutSeconds: Long = DEFAULT_CLAMAV_SECONDS,
    val clamavConnectTimeoutSeconds: Long = DEFAULT_CLAMAV_CONNECT_SECONDS,
    val clamavFailClosed: Boolean = false,
    val orphanGraceSeconds: Long = DEFAULTS.orphanGrace.inWholeSeconds,
    val sweepIntervalSeconds: Long = DEFAULTS.orphanGrace.inWholeSeconds,
) {
    init {
        require(dir.isNotBlank()) { "DRAWBOARD_FILES_DIR must be set: the directory the uploaded files are stored in" }
        require(maxFileBytes > 0 && maxVideoBytes >= maxFileBytes) { "files.max-video-bytes must not be smaller than files.max-file-bytes" }
        require(maxFilesPerBoard >= 1 && uploadsPerMinute >= 1 && conversionsPerMinute >= 1) { "the file limits must be positive" }
        require(clamavPort in 1..MAX_PORT && clamavMaxBytes >= 1 && clamavTimeoutSeconds >= 1 && clamavConnectTimeoutSeconds >= 1) {
            "the ClamAV settings must be positive and the port a port number"
        }
        require(decodeThreads >= 1 && decodeTimeoutSeconds >= 1 && conversionTimeoutSeconds >= 1) { "the file timeouts must be positive" }
    }

    /** The signing keys: the file wins over the variable; none at all stops the start. */
    fun signingKeys(): List<ByteArray> {
        val file = urlKeysFile?.takeIf { it.isNotBlank() }
        val text = if (file != null) Files.readString(Path.of(file)) else urlKeys.orEmpty()
        return FileUrlSigner.parseKeys(text, "DRAWBOARD_FILE_URL_KEYS")
    }

    val gotenbergUrlOrNull: String? get() = gotenbergUrl?.takeIf { it.isNotBlank() }

    val sameSiteOrigin: Boolean get() = !filesOrigin.isNullOrBlank()

    private companion object {
        val DEFAULTS = FilesLimits()
        const val DEFAULT_DECODE_THREADS = 2
        const val DEFAULT_DECODE_SECONDS = 10L
        const val DEFAULT_CLAMAV_PORT = 3310
        const val DEFAULT_CLAMAV_MAX_BYTES = 25L * 1024 * 1024
        const val DEFAULT_CLAMAV_SECONDS = 60L
        const val DEFAULT_CLAMAV_CONNECT_SECONDS = 3L
        const val MAX_PORT = 65535
    }
}
