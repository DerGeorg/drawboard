package at.dergeorg.drawboard.api.domain.plugins.plugins.provides

import at.dergeorg.drawboard.contract.model.EnabledPluginList
import at.dergeorg.drawboard.contract.model.Plugin
import at.dergeorg.drawboard.contract.model.PluginList
import at.dergeorg.drawboard.contract.model.PluginStorage
import at.dergeorg.drawboard.contract.model.PluginStorageUpdate
import at.dergeorg.drawboard.contract.model.PluginUpdate
import org.springframework.http.codec.multipart.Part
import kotlin.uuid.Uuid

/** The plugins part of the API in contract types: the management by instance admins, the list a board host loads, the plugin storage. */
interface PluginsApiUseCase {

    suspend fun listPlugins(): PluginList

    suspend fun installPlugin(file: Part): Plugin

    suspend fun getPlugin(pluginId: String): Plugin

    suspend fun updatePlugin(pluginId: String, update: PluginUpdate): Plugin

    suspend fun removePlugin(pluginId: String)

    suspend fun listEnabledPlugins(): EnabledPluginList

    suspend fun getPluginStorage(boardId: Uuid, pluginId: String): PluginStorage

    suspend fun putPluginStorage(boardId: Uuid, pluginId: String, update: PluginStorageUpdate): PluginStorage
}
