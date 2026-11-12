package at.dergeorg.drawboard.plugins.domain

import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginAsset
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginStorageData
import at.dergeorg.drawboard.plugins.domain.plugins.requires.BundleFile
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginFileRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginStorageRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.Transactions
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.time.Instant
import kotlin.uuid.Uuid

internal class InMemoryPluginRepository : PluginRepository {
    val rows = linkedMapOf<String, InstalledPlugin>()

    override suspend fun findById(id: String) = rows[id]
    override suspend fun findAll() = rows.values.sortedBy { it.id }
    override suspend fun findEnabled() = findAll().filter { it.enabled }

    override suspend fun insert(plugin: InstalledPlugin): InstalledPlugin {
        check(plugin.revision == null) { "a new row has no revision" }
        check(plugin.id !in rows) { "duplicate id" }
        return plugin.copy(revision = 0).also { rows[it.id] = it }
    }

    override suspend fun update(plugin: InstalledPlugin): InstalledPlugin? {
        val current = rows[plugin.id] ?: return null
        if (current.revision != plugin.revision) return null
        return plugin.copy(revision = current.revision!! + 1).also { rows[it.id] = it }
    }

    override suspend fun delete(id: String) {
        rows.remove(id)
    }
}

internal class InMemoryPluginFiles : PluginFileRepository {
    val files = linkedMapOf<Triple<String, String, String>, PluginAsset>()

    override suspend fun insertAll(pluginId: String, bundleSha256: String, files: List<BundleFile>) {
        files.forEach { this.files[Triple(pluginId, bundleSha256, it.path)] = PluginAsset(it.path, it.mediaType, it.data) }
    }

    override suspend fun find(pluginId: String, bundleSha256: String, path: String) = files[Triple(pluginId, bundleSha256, path)]

    override suspend fun deleteBundle(pluginId: String, bundleSha256: String) {
        files.keys.removeAll { it.first == pluginId && it.second == bundleSha256 }
    }

    override suspend fun deleteAll(pluginId: String) {
        files.keys.removeAll { it.first == pluginId }
    }
}

internal class InMemoryPluginStorage : PluginStorageRepository {
    val rows = linkedMapOf<Pair<Uuid, String>, PluginStorageData>()

    override suspend fun find(boardId: Uuid, pluginId: String) = rows[boardId to pluginId]

    override suspend fun insert(boardId: Uuid, pluginId: String, json: String, at: Instant): Boolean {
        if ((boardId to pluginId) in rows) return false
        rows[boardId to pluginId] = PluginStorageData(json, 1)
        return true
    }

    override suspend fun update(boardId: Uuid, pluginId: String, json: String, expectedVersion: Long, at: Instant): Boolean {
        val current = rows[boardId to pluginId] ?: return false
        if (current.version != expectedVersion) return false
        rows[boardId to pluginId] = PluginStorageData(json, expectedVersion + 1)
        return true
    }

    override suspend fun deleteByBoards(boardIds: Collection<Uuid>) {
        rows.keys.removeAll { it.first in boardIds }
    }

    override suspend fun deleteByPlugin(pluginId: String) {
        rows.keys.removeAll { it.second == pluginId }
    }
}

internal object DirectTransactions : Transactions {
    override suspend fun <T> required(block: suspend () -> T): T = block()
}

/** Builds plugin ZIPs and manifests for tests. */
internal object Zips {

    fun manifest(
        id: String = "org.example.timer",
        version: String = "1.0.0",
        entry: String = "dist/index.js",
        blockTypes: String = """[{"type":"$id.countdown","label":"Countdown","defaultWidth":240,"defaultHeight":120}]""",
        capabilities: String = """[{"name":"block.props"},{"name":"storage"},{"name":"network","value":"time.example.org"}]""",
        extra: String = "",
    ) = """{"manifestVersion":1,"id":"$id","name":"Timer","version":"$version","description":"A countdown.","entry":"$entry",""" +
        """"minHostVersion":"1.0.0",""" +
        """"blockTypes":$blockTypes,"capabilities":$capabilities$extra}"""

    /** A valid plugin: the manifest, the entry module and a style sheet. */
    fun plugin(manifest: String = manifest(), entry: String = "dist/index.js", vararg more: Pair<String, ByteArray>): ByteArray =
        zip(
            "drawboard-plugin.json" to manifest.toByteArray(),
            entry to "export default {};".toByteArray(),
            "style.css" to "body{}".toByteArray(),
            *more,
        )

    fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { (name, data) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(data)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    /** The ZIP with the Unix mode of the entry [name] set to a symbolic link (in the central directory, where it lives). */
    fun withSymlink(zip: ByteArray, name: String): ByteArray {
        val bytes = zip.copyOf()
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var at = 0
        while (at + 46 < bytes.size) {
            if (buffer.getInt(at) == 0x02014b50) {
                val nameLength = buffer.getShort(at + 28).toInt()
                if (String(bytes, at + 46, nameLength) == name) {
                    buffer.putShort(at + 4, ((3 shl 8) or 20).toShort()) // made by Unix
                    buffer.putInt(at + 38, 0xA1FF shl 16) // symlink, rwxrwxrwx
                }
                at += 46 + nameLength + buffer.getShort(at + 30) + buffer.getShort(at + 32)
            } else {
                at++
            }
        }
        return bytes
    }
}
