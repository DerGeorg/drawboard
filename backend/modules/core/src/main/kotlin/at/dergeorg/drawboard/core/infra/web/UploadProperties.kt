package at.dergeorg.drawboard.core.infra.web

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Caps and limits the upload guard ([UploadGuardWebFilter]) enforces from the request HEADERS, before Spring's multipart
 * reader spools a single byte (M3 backend review, MUST 1). The byte caps follow the properties the handlers use
 * (see application.yaml), plus [envelopeBytes] for the multipart boundaries and part headers, which `Content-Length` includes.
 *
 * @param maxFileBytes `POST /api/boards/{id}/files`: the largest upload there is, a video (`files.max-video-bytes`).
 * @param maxSnapshotBytes `PUT /api/boards/{id}/snapshot` (`collab.max-snapshot-bytes`).
 * @param maxPluginBytes `POST /api/admin/plugins`: the plugin ZIP (the handler reads at most 20 MB of it).
 * @param envelopeBytes slack on top of each cap for the multipart envelope.
 * @param perUserConcurrent uploads one signed-in user may have in flight at once (all three routes together), else 429.
 * @param perUserPerMinute uploads one user may START per minute and route (`files.uploads-per-minute`), else 429. The
 *   services keep their own limits (a second line, own counters): this one just answers before the body is read.
 * @param globalConcurrent uploads in flight in the whole instance; with the caps it bounds the spool directory
 *   (`globalConcurrent` x the largest upload).
 */
@ConfigurationProperties("app.uploads")
internal data class UploadProperties(
    val maxFileBytes: Long = DEFAULT_FILE_BYTES,
    val maxSnapshotBytes: Long = DEFAULT_SNAPSHOT_BYTES,
    val maxPluginBytes: Long = DEFAULT_PLUGIN_BYTES,
    val envelopeBytes: Long = DEFAULT_ENVELOPE_BYTES,
    val perUserConcurrent: Int = DEFAULT_PER_USER_CONCURRENT,
    val perUserPerMinute: Int = DEFAULT_PER_MINUTE,
    val globalConcurrent: Int = DEFAULT_GLOBAL_CONCURRENT,
) {
    init {
        require(maxFileBytes > 0 && maxSnapshotBytes > 0 && maxPluginBytes > 0 && envelopeBytes >= 0) { "the upload caps must be positive" }
        require(perUserConcurrent >= 1 && perUserPerMinute >= 1 && globalConcurrent >= perUserConcurrent) {
            "app.uploads: the concurrency limits must be positive and the global one at least the per-user one"
        }
    }

    private companion object {
        const val MIB = 1024L * 1024
        const val DEFAULT_FILE_BYTES = 500 * MIB
        const val DEFAULT_SNAPSHOT_BYTES = 50 * MIB
        const val DEFAULT_PLUGIN_BYTES = 20 * MIB
        const val DEFAULT_ENVELOPE_BYTES = MIB
        const val DEFAULT_PER_USER_CONCURRENT = 2
        const val DEFAULT_PER_MINUTE = 30
        const val DEFAULT_GLOBAL_CONCURRENT = 8
    }
}
