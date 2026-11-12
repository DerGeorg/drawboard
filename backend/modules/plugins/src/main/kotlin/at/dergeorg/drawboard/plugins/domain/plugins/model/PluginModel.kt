package at.dergeorg.drawboard.plugins.domain.plugins.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * What a plugin may ask the host for (S3.8). [name] is the wire name (`block.props`, `network`, ...), [value] only for
 * `import.register` (one media type) and `network` (the host list). A grant equals a request in name AND value.
 */
data class Capability(val name: String, val value: String? = null) {
    /** `name` or `name:value`: how a capability is named in an error. */
    val label: String get() = if (value == null) name else "$name:$value"
}

/** A block type a plugin contributes (from its manifest). */
data class BlockTypeDef(val type: String, val label: String, val defaultWidth: Int, val defaultHeight: Int)

/**
 * An installed plugin as an instance admin sees it. [bundleSha256] is the hash in the asset path, [bundleSha384] the one
 * shown to the admin (the install checksum, S3.6, S7.1); [integrity] the SRI value of the entry module. [revision] is the
 * optimistic lock of the installation (null = not stored yet).
 */
data class InstalledPlugin(
    val id: String,
    val name: String,
    val version: String,
    val description: String?,
    val enabled: Boolean,
    val installedAt: Instant,
    val installedBy: Uuid,
    val bundleSha256: String,
    val bundleSha384: String,
    val entry: String,
    val integrity: String,
    val blockTypes: List<BlockTypeDef>,
    val requestedCapabilities: List<Capability>,
    val grantedCapabilities: List<Capability>,
    val revision: Long? = null,
) {
    /** `/plugin-assets/<id>/<version>/<sha256>/`, the immutable path the files are served from (S3.5). */
    val assetPath: String get() = "/plugin-assets/$id/$version/$bundleSha256/"
}

/** What a board host needs to load an enabled plugin - no installer information. [assetBase] is a path or a URL on the plugin origin. */
data class EnabledPlugin(
    val id: String,
    val version: String,
    val assetBase: String,
    val entry: String,
    val integrity: String,
    val blockTypes: List<BlockTypeDef>,
    val grantedCapabilities: List<Capability>,
    val userPseudonym: String,
)

/** A file of an installed bundle, as served: exact bytes, the media type of its extension. */
class PluginAsset(val path: String, val mediaType: String, val data: ByteArray)

/** The generated frame document and the headers it needs (S3.3, S3.6). */
class FrameDocument(val html: String, val contentSecurityPolicy: String)

/** The `storage` of one plugin on one board: an opaque JSON object as text, and its version (0 = never written). */
data class PluginStorageData(val json: String, val version: Long)
