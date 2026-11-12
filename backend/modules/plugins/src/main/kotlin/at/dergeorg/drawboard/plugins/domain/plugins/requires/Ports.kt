package at.dergeorg.drawboard.plugins.domain.plugins.requires

import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginAsset
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginStorageData
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Port: the installed plugins. */
internal interface PluginRepository {

    suspend fun findById(id: String): InstalledPlugin?

    /** Ordered by id. */
    suspend fun findAll(): List<InstalledPlugin>

    suspend fun findEnabled(): List<InstalledPlugin>

    /** [plugin] must have no revision: a new row. */
    suspend fun insert(plugin: InstalledPlugin): InstalledPlugin

    /** Writes [plugin] based on its revision; null if another change won in between (or the plugin is gone). */
    suspend fun update(plugin: InstalledPlugin): InstalledPlugin?

    suspend fun delete(id: String)
}

/** A file of a bundle on its way into the store. */
internal class BundleFile(val path: String, val mediaType: String, val data: ByteArray)

/** Port: the files of the installed bundles - the entry list of an install is the set of rows with its hash. */
internal interface PluginFileRepository {

    suspend fun insertAll(pluginId: String, bundleSha256: String, files: List<BundleFile>)

    /** The file at exactly [path] of the bundle, or null. */
    suspend fun find(pluginId: String, bundleSha256: String, path: String): PluginAsset?

    suspend fun deleteBundle(pluginId: String, bundleSha256: String)

    suspend fun deleteAll(pluginId: String)
}

/** Port: the key-value object per plugin and board. */
internal interface PluginStorageRepository {

    suspend fun find(boardId: Uuid, pluginId: String): PluginStorageData?

    /** False if there is already a row for this plugin and board (a concurrent first write won). */
    suspend fun insert(boardId: Uuid, pluginId: String, json: String, at: Instant): Boolean

    /** Replaces the object if the stored version is [expectedVersion] and raises the version; false if it is not. */
    suspend fun update(boardId: Uuid, pluginId: String, json: String, expectedVersion: Long, at: Instant): Boolean

    suspend fun deleteByBoards(boardIds: Collection<Uuid>)

    suspend fun deleteByPlugin(pluginId: String)
}

/** Port: a short database transaction around [block]. */
internal interface Transactions {
    suspend fun <T> required(block: suspend () -> T): T
}
