package at.dergeorg.drawboard.plugins.domain.plugins.provides

import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.EnabledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.FrameDocument
import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginAsset
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginStorageData
import kotlin.uuid.Uuid

/**
 * What the plugins module offers: the registry of installed plugins, their assets and their storage (S3). Like the
 * files module it trusts its caller (module `api`) with the checks that need a token or a board: that only an instance
 * admin installs, and which role a board user has. The module knows neither tokens, roles nor boards.
 */
interface PluginsUseCase {

    /** Every installed plugin, ordered by id. */
    suspend fun list(): List<InstalledPlugin>

    suspend fun get(pluginId: String): InstalledPlugin

    /**
     * Installs or upgrades a plugin from a ZIP (S3.9, docs/plugin-protocol.md). A new id is installed DISABLED with no
     * grant; a higher version of an installed id keeps `enabled` and the grants the new version still requests; the same
     * or a lower version is `PLUGINS_VERSION_EXISTS`. Audited with the hash and the installer.
     */
    suspend fun install(command: InstallPluginCommand): InstalledPlugin

    /** Sets `enabled` and the complete set of granted capabilities; `CONFLICT` for another [UpdatePluginCommand.revision]. Audited. */
    suspend fun update(command: UpdatePluginCommand): InstalledPlugin

    /** Removes the plugin, its files and its storage on every board. Audited. */
    suspend fun remove(pluginId: String)

    /** `assetBase` as the browser addresses it: the path, or a URL on the plugin origin when the deployment has one (S3.4). */
    fun assetBase(plugin: InstalledPlugin): String

    /** The enabled plugins for a board host, with the pseudonymous id of [principalId] (a user's or a guest's id) per plugin. */
    suspend fun listEnabled(principalId: Uuid): List<EnabledPlugin>

    /** The `storage` of an ENABLED plugin on a board that has `storage` granted (`PLUGINS_PLUGIN_NOT_FOUND`, `FORBIDDEN` otherwise). */
    suspend fun readStorage(boardId: Uuid, pluginId: String): PluginStorageData

    /** Replaces the storage; `CONFLICT` for another version, `PAYLOAD_TOO_LARGE` above 1 MB. */
    suspend fun writeStorage(command: WriteStorageCommand): PluginStorageData

    /**
     * The file behind `/plugin-assets/<id>/<version>/<sha256>/<path>` - resolved against the entry list stored at install
     * (an exact match of the path, never a file system join), only for an enabled plugin and its current bundle - or the
     * generated frame document for `__drawboard/frame.html`. Null = 404.
     */
    suspend fun serve(pluginId: String, version: String, sha256: String, path: String): ServedAsset?

    /** Deletes the storage of the plugins on boards that were purged for good (S7.7). */
    suspend fun deleteBoardData(boardIds: Collection<Uuid>)
}

/** The cap of a plugin upload (S3.9): 20 MB. */
const val PLUGIN_UPLOAD_LIMIT_BYTES: Long = 20L * 1024 * 1024

/** What [PluginsUseCase.serve] found. */
sealed interface ServedAsset {
    class File(val asset: PluginAsset) : ServedAsset

    class Frame(val document: FrameDocument) : ServedAsset
}

/** Input of [PluginsUseCase.install]: the ZIP as received (the 20 MB cap was applied by the caller) and the installing admin. */
class InstallPluginCommand(val installerId: Uuid, val zip: ByteArray)

/** Input of [PluginsUseCase.update]: the complete new state the admin controls and the revision it is based on. */
data class UpdatePluginCommand(val pluginId: String, val enabled: Boolean, val grantedCapabilities: List<Capability>, val revision: Long)

/**
 * Input of [PluginsUseCase.writeStorage]: the new object as JSON text and the version it is based on, and the user who writes it
 * ([writerId]: the writes of one user to one board are rate limited).
 */
class WriteStorageCommand(val boardId: Uuid, val pluginId: String, val json: String, val version: Long, val writerId: Uuid)
