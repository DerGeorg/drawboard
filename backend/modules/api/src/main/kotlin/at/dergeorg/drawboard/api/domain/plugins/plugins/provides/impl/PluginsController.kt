package at.dergeorg.drawboard.api.domain.plugins.plugins.provides.impl

import at.dergeorg.drawboard.api.domain.plugins.plugins.provides.PluginsApiUseCase
import at.dergeorg.drawboard.contract.api.PluginsApi
import at.dergeorg.drawboard.contract.model.EnabledPluginList
import at.dergeorg.drawboard.contract.model.Plugin
import at.dergeorg.drawboard.contract.model.PluginList
import at.dergeorg.drawboard.contract.model.PluginStorage
import at.dergeorg.drawboard.contract.model.PluginStorageUpdate
import at.dergeorg.drawboard.contract.model.PluginUpdate
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.ResponseEntity
import org.springframework.http.codec.multipart.Part
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.util.UriComponentsBuilder
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [PluginsApi] and delegates to [PluginsApiUseCase]. The route table in core decides
 * who may call what - `/admin/plugins` is for instance admins (S6.6), `/plugins` and the storage are open to guests (read).
 * The plugin ASSETS are not an operation of the contract: see `PluginAssetsController`.
 */
@RestController
internal class PluginsController(
    private val plugins: PluginsApiUseCase,
    @Value("\${api.base-path:/api}") private val basePath: String,
) : PluginsApi {

    @WithSpan
    override suspend fun listPlugins(): ResponseEntity<PluginList> = ResponseEntity.ok(plugins.listPlugins())

    @WithSpan
    override suspend fun installPlugin(file: Part): ResponseEntity<Plugin> {
        val installed = plugins.installPlugin(file)
        val location = UriComponentsBuilder.fromPath(basePath).path(PluginsApi.PATH_GET_PLUGIN).buildAndExpand(installed.id).toUri()
        return ResponseEntity.created(location).body(installed)
    }

    @WithSpan
    override suspend fun getPlugin(
        @SpanAttribute("plugin.id") pluginId: String,
    ): ResponseEntity<Plugin> = ResponseEntity.ok(plugins.getPlugin(pluginId))

    @WithSpan
    override suspend fun updatePlugin(@SpanAttribute("plugin.id") pluginId: String, pluginUpdate: PluginUpdate): ResponseEntity<Plugin> =
        ResponseEntity.ok(plugins.updatePlugin(pluginId, pluginUpdate))

    @WithSpan
    override suspend fun removePlugin(@SpanAttribute("plugin.id") pluginId: String): ResponseEntity<Unit> {
        plugins.removePlugin(pluginId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun listEnabledPlugins(): ResponseEntity<EnabledPluginList> = ResponseEntity.ok(plugins.listEnabledPlugins())

    @WithSpan
    override suspend fun getPluginStorage(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("plugin.id") pluginId: String,
    ): ResponseEntity<PluginStorage> =
        ResponseEntity.ok(plugins.getPluginStorage(boardId, pluginId))

    @WithSpan
    override suspend fun putPluginStorage(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("plugin.id") pluginId: String,
        pluginStorageUpdate: PluginStorageUpdate,
    ): ResponseEntity<PluginStorage> = ResponseEntity.ok(plugins.putPluginStorage(boardId, pluginId, pluginStorageUpdate))
}
