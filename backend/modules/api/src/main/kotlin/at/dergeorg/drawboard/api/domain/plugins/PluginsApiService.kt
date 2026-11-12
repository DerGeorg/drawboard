package at.dergeorg.drawboard.api.domain.plugins

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.domain.plugins.plugins.provides.PluginsApiUseCase
import at.dergeorg.drawboard.contract.model.EnabledPlugin
import at.dergeorg.drawboard.contract.model.EnabledPluginList
import at.dergeorg.drawboard.contract.model.Plugin
import at.dergeorg.drawboard.contract.model.PluginBlockType
import at.dergeorg.drawboard.contract.model.PluginCapability
import at.dergeorg.drawboard.contract.model.PluginCapabilityName
import at.dergeorg.drawboard.contract.model.PluginList
import at.dergeorg.drawboard.contract.model.PluginStorage
import at.dergeorg.drawboard.contract.model.PluginStorageUpdate
import at.dergeorg.drawboard.contract.model.PluginUpdate
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.plugins.domain.plugins.model.BlockTypeDef
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.provides.InstallPluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.PLUGIN_UPLOAD_LIMIT_BYTES
import at.dergeorg.drawboard.plugins.domain.plugins.provides.PluginsUseCase
import at.dergeorg.drawboard.plugins.domain.plugins.provides.UpdatePluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.WriteStorageCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.core.io.buffer.DataBufferLimitException
import org.springframework.core.io.buffer.DataBufferUtils
import org.springframework.http.codec.multipart.Part
import org.springframework.stereotype.Service
import tools.jackson.databind.json.JsonMapper
import kotlin.uuid.Uuid

/**
 * Implements the API use cases of the plugins module. Installing and managing are for instance admins (the groups of the
 * CURRENT token - decided by the route table in core, checked once more here); the list of enabled plugins is for every
 * signed-in user and guest; the plugin storage follows the role on the board (read: any role, write: editor or owner who
 * is signed in - never a guest). A plugin never sees a user id: it gets the pseudonym of the module.
 */
@Service
@Suppress("TooManyFunctions")
internal class PluginsApiService(
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val plugins: PluginsUseCase,
    private val json: JsonMapper,
) : PluginsApiUseCase {

    @WithSpan
    override suspend fun listPlugins(): PluginList {
        requireAdmin()
        return PluginList(items = plugins.list().map { it.toContract() })
    }

    @WithSpan
    override suspend fun installPlugin(file: Part): Plugin {
        val admin = requireAdmin()
        return plugins.install(InstallPluginCommand(admin, readLimited(file))).toContract()
    }

    @WithSpan
    override suspend fun getPlugin(@SpanAttribute("plugin.id") pluginId: String): Plugin {
        requireAdmin()
        return plugins.get(pluginId).toContract()
    }

    @WithSpan
    override suspend fun updatePlugin(@SpanAttribute("plugin.id") pluginId: String, update: PluginUpdate): Plugin {
        requireAdmin()
        val granted = update.grantedCapabilities.map { Capability(it.name.value, it.value) }
        return plugins.update(UpdatePluginCommand(pluginId, update.enabled, granted, update.revision)).toContract()
    }

    @WithSpan
    override suspend fun removePlugin(@SpanAttribute("plugin.id") pluginId: String) {
        requireAdmin()
        plugins.remove(pluginId)
    }

    @WithSpan
    override suspend fun listEnabledPlugins(): EnabledPluginList {
        val principal = callers.guestOrNull()?.id ?: signedIn.profile().id
        return EnabledPluginList(
            items = plugins.listEnabled(principal).map {
                EnabledPlugin(
                    id = it.id, version = it.version, assetBase = it.assetBase, entry = it.entry, integrity = it.integrity,
                    blockTypes = it.blockTypes.map(::blockType), grantedCapabilities = it.grantedCapabilities.map(::capability),
                    userPseudonym = it.userPseudonym,
                )
            },
        )
    }

    @WithSpan
    override suspend fun getPluginStorage(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("plugin.id") pluginId: String,
    ): PluginStorage {
        boards.roleOf(callers.any(), boardId) ?: throw boardNotFound(boardId)
        val stored = plugins.readStorage(boardId, pluginId)
        return PluginStorage(data = parseObject(stored.json), version = stored.version)
    }

    @WithSpan
    override suspend fun putPluginStorage(
        @SpanAttribute("board.id") boardId: Uuid,
        @SpanAttribute("plugin.id") pluginId: String,
        update: PluginStorageUpdate,
    ): PluginStorage {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
        val caller = signedIn.caller()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (role != BoardRole.OWNER && role != BoardRole.EDITOR) {
            throw DomainException(
                ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                mapOf("boardId" to boardId.toString(), "required" to "EDITOR or OWNER"),
            )
        }
        val command = WriteStorageCommand(boardId, pluginId, json.writeValueAsString(update.data), update.version, caller.id)
        val stored = plugins.writeStorage(command)
        return PluginStorage(data = parseObject(stored.json), version = stored.version)
    }

    /** The caller must be an instance admin and not a guest; returns the admin's own user id. 403 FORBIDDEN otherwise. */
    private suspend fun requireAdmin(): Uuid {
        if (callers.guestOrNull() != null || !signedIn.isAdmin()) throw DomainException(ErrorCode.FORBIDDEN)
        return signedIn.profile().id
    }

    private fun boardNotFound(boardId: Uuid) = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))

    @Suppress("UNCHECKED_CAST")
    private fun parseObject(text: String): Map<String, Any> = json.readValue(text, Map::class.java) as Map<String, Any>

    /** The bytes of the uploaded ZIP; more than 20 MB stops the read at once (413), nothing beyond is buffered. */
    private suspend fun readLimited(part: Part): ByteArray {
        val limit = PLUGIN_UPLOAD_LIMIT_BYTES
        val buffer = try {
            DataBufferUtils.join(part.content(), limit.toInt()).awaitSingleOrNull()
        } catch (_: DataBufferLimitException) {
            throw PayloadTooLargeException(limit)
        } ?: throw ValidationFailedException(listOf(InvalidField("file", "NotEmpty", "must not be empty")))
        try {
            return ByteArray(buffer.readableByteCount()).also(buffer::read)
        } finally {
            DataBufferUtils.release(buffer)
        }
    }

    private fun InstalledPlugin.toContract() = Plugin(
        id = id, name = name, version = version, enabled = enabled, installedAt = installedAt, installedBy = installedBy,
        bundleSha384 = bundleSha384, assetBase = plugins.assetBase(this), blockTypes = blockTypes.map(::blockType),
        requestedCapabilities = requestedCapabilities.map(::capability), grantedCapabilities = grantedCapabilities.map(::capability),
        revision = checkNotNull(revision) { "plugin $id has no revision" }, description = description,
    )

    private fun blockType(type: BlockTypeDef) = PluginBlockType(type.type, type.label, type.defaultWidth, type.defaultHeight)

    private fun capability(capability: Capability) = PluginCapability(
        name = PluginCapabilityName.entries.first { it.value == capability.name },
        value = capability.value,
    )
}
