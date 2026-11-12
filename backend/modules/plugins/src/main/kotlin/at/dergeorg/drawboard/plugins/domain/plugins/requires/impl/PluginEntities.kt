package at.dergeorg.drawboard.plugins.domain.plugins.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.annotation.Version
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `plugins.plugin`. Only used inside requires/impl; the domain sees `InstalledPlugin`. */
@Table(schema = "plugins", name = "plugin")
internal data class PluginEntity(
    @Id val id: String,
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
    /** JSON lists - the adapter turns them into the domain's lists. */
    val blockTypes: String,
    val requestedCapabilities: String,
    val grantedCapabilities: String,
    /** Optimistic lock; `null` also marks a new row (the id is given by the application, see BoardEntity). */
    @Version val revision: Long? = null,
)

/** Row of `plugins.plugin_file`: one file of a bundle. */
@Table(schema = "plugins", name = "plugin_file")
internal data class PluginFileEntity(
    @Id val id: Uuid,
    val pluginId: String,
    val bundleSha256: String,
    val path: String,
    val mediaType: String,
    val size: Long,
    val data: ByteArray,
)

/** Row of `plugins.plugin_storage`. */
@Table(schema = "plugins", name = "plugin_storage")
internal data class PluginStorageEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val pluginId: String,
    val data: String,
    val version: Long,
    val updatedAt: Instant,
)
