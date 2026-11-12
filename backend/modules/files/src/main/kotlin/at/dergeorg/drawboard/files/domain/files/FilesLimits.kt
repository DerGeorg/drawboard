package at.dergeorg.drawboard.files.domain.files

import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds

/** The numbers the file use cases work with; built from `files.*` in infra (S4.1, S4.8, S4.10, S7.3). Sizes are bytes. */
internal data class FilesLimits(
    val maxFileBytes: Long = DEFAULT_FILE_MIB * MIB,
    val maxVideoBytes: Long = DEFAULT_VIDEO_MIB * MIB,
    val maxBytesPerUser: Long = DEFAULT_USER_GIB * GIB,
    val maxBytesPerBoard: Long = DEFAULT_BOARD_GIB * GIB,
    val maxFilesPerBoard: Int = DEFAULT_FILES_PER_BOARD,
    val uploadsPerMinute: Int = DEFAULT_UPLOADS_PER_MINUTE,
    val uploadBytesPerMinute: Long = GIB,
    val conversionsPerMinute: Int = DEFAULT_CONVERSIONS_PER_MINUTE,
    val conversionTimeout: Duration = DEFAULT_CONVERSION_SECONDS.seconds,
    /** Whether a converter is configured; without one a document is stored with `conversion: FAILED`. */
    val conversionEnabled: Boolean = true,
    val conversionQueue: Int = DEFAULT_CONVERSION_QUEUE,
    /** A decoded image may have at most this many pixels (S4.8). */
    val maxPixels: Long = DEFAULT_MAX_PIXELS,
    /** A progressive JPEG with more pixels than this is stored but gets no thumbnail: libjpeg holds ~6 bytes a pixel for it, natively. */
    val maxProgressivePixels: Long = DEFAULT_MAX_PROGRESSIVE_PIXELS,
    val orphanGrace: Duration = DEFAULT_GRACE_HOURS.hours,
    /** What happens when the scanner cannot decide (S4.12): true refuses the upload, false (default) accepts it and counts it. */
    val scanFailClosed: Boolean = false,
) {
    companion object {
        const val MIB = 1024L * 1024
        const val GIB = 1024L * MIB
        const val DEFAULT_FILE_MIB = 50L
        const val DEFAULT_VIDEO_MIB = 500L
        const val DEFAULT_USER_GIB = 5L
        const val DEFAULT_BOARD_GIB = 2L
        const val DEFAULT_FILES_PER_BOARD = 500
        const val DEFAULT_UPLOADS_PER_MINUTE = 30
        const val DEFAULT_CONVERSIONS_PER_MINUTE = 10
        const val DEFAULT_CONVERSION_SECONDS = 60
        const val DEFAULT_CONVERSION_QUEUE = 100
        const val DEFAULT_MAX_PIXELS = 50_000_000L
        const val DEFAULT_MAX_PROGRESSIVE_PIXELS = 16_000_000L
        const val DEFAULT_GRACE_HOURS = 24
    }
}
