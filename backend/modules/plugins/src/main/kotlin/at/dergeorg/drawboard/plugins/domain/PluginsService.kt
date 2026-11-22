package at.dergeorg.drawboard.plugins.domain

import at.dergeorg.drawboard.plugins.common.PluginsModule
import at.dergeorg.drawboard.plugins.domain.archive.ArchiveProblem
import at.dergeorg.drawboard.plugins.domain.archive.ArchiveUnpacker
import at.dergeorg.drawboard.plugins.domain.archive.PluginArchive
import at.dergeorg.drawboard.plugins.domain.archive.refuse
import at.dergeorg.drawboard.plugins.domain.frame.FrameDocuments
import at.dergeorg.drawboard.plugins.domain.manifest.Manifest
import at.dergeorg.drawboard.plugins.domain.manifest.ManifestResult
import at.dergeorg.drawboard.plugins.domain.manifest.ManifestValidator
import at.dergeorg.drawboard.plugins.domain.manifest.SemVer
import at.dergeorg.drawboard.plugins.domain.plugins.PluginAssets
import at.dergeorg.drawboard.plugins.domain.plugins.PluginSettings
import at.dergeorg.drawboard.plugins.domain.plugins.UserPseudonyms
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.EnabledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginGrantsChanged
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginInstalled
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginRemoved
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginStorageData
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginSwitched
import at.dergeorg.drawboard.plugins.domain.plugins.provides.InstallPluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.PluginsUseCase
import at.dergeorg.drawboard.plugins.domain.plugins.provides.ServedAsset
import at.dergeorg.drawboard.plugins.domain.plugins.provides.UpdatePluginCommand
import at.dergeorg.drawboard.plugins.domain.plugins.provides.WriteStorageCommand
import at.dergeorg.drawboard.plugins.domain.plugins.requires.BundleFile
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginFileRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginStorageRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.Transactions
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.FieldViolationsException
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.PayloadTooLargeException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.springframework.stereotype.Service
import tools.jackson.core.JacksonException
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import java.security.MessageDigest
import java.util.Base64
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.uuid.Uuid

/** The manifest of an upload is invalid: `PLUGINS_MANIFEST_INVALID` with one violation per problem (field = JSON path). */
internal class ManifestInvalidException(fields: List<InvalidField>) : FieldViolationsException(ErrorCode.PLUGINS_MANIFEST_INVALID, fields)

/**
 * Implements the plugin use cases (S3). An upload passes the archive rules (nothing is extracted), the manifest schema and
 * the rules of the namespace, and is stored as rows - the manifest and the entry list are what is served later. A plugin
 * is installed DISABLED with nothing granted: it does nothing until an instance admin decides (S3.8).
 */
@Service
@Suppress("TooManyFunctions")
internal class PluginsService(
    private val plugins: PluginRepository,
    private val bundles: PluginFileRepository,
    private val storage: PluginStorageRepository,
    private val transactions: Transactions,
    private val settings: PluginSettings,
    private val json: JsonMapper,
    private val audit: AuditTrail,
    private val clock: Clock,
    private val archive: ArchiveUnpacker = PluginArchive(),
) : PluginsUseCase {

    private val events = DomainEvents(PluginsModule.NAME)
    private val pseudonyms = UserPseudonyms(settings.pseudonymKey)
    private val installs = WindowRateLimiter(clock, RateRule(settings.installsPerMinute, 1.minutes))
    private val storageWrites = WindowRateLimiter(clock, RateRule(settings.storageWritesPerMinute, 1.minutes))

    /**
     * Installs run one at a time, from unpacking to commit: two uploads of the same id must not both pass the version check,
     * and only one unpacked archive (up to 50 MiB) is in memory at a time, however many uploads arrive (S3 SHOULD of the
     * Fable review "Plugin archive memory").
     */
    private val installLock = Mutex()

    @WithSpan
    override suspend fun list(): List<InstalledPlugin> = plugins.findAll()

    @WithSpan
    override suspend fun get(@SpanAttribute("plugin.id") pluginId: String): InstalledPlugin =
        plugins.findById(pluginId) ?: throw notFound(pluginId)

    @WithSpan
    override suspend fun install(command: InstallPluginCommand): InstalledPlugin {
        installs.take(command.installerId.toString())
        return installLock.withLock {
            // inflating and hashing is CPU work: never on an event-loop thread
            val bundle = withContext(Dispatchers.Default) { readBundle(command.zip) }
            val manifest = bundle.manifest
            transactions.required {
                val existing = plugins.findById(manifest.id)
                requireNamespaceFree(manifest, plugins.findAll())
                if (existing != null && !isNewer(manifest.version, existing.version)) {
                    throw DomainException(
                        ErrorCode.PLUGINS_VERSION_EXISTS,
                        mapOf("pluginId" to manifest.id, "installedVersion" to existing.version),
                    )
                }
                val kept = existing?.grantedCapabilities.orEmpty().filter { it in manifest.capabilities } // equal in name AND value
                val candidate = InstalledPlugin(
                    id = manifest.id, name = manifest.name, version = manifest.version, description = manifest.description,
                    enabled = existing?.enabled ?: false, installedAt = clock.now(), installedBy = command.installerId,
                    bundleSha256 = bundle.sha256, bundleSha384 = bundle.sha384, entry = manifest.entry, integrity = bundle.integrity,
                    blockTypes = manifest.blockTypes, requestedCapabilities = manifest.capabilities, grantedCapabilities = kept,
                    revision = existing?.revision,
                )
                bundles.insertAll(manifest.id, bundle.sha256, bundle.files)
                val stored = if (existing == null) plugins.insert(candidate) else plugins.update(candidate) ?: throw conflict(existing)
                if (existing != null && existing.bundleSha256 != bundle.sha256) bundles.deleteBundle(manifest.id, existing.bundleSha256)
                val details = PluginInstalled(
                    version = stored.version, previousVersion = existing?.version, sha256 = bundle.sha256, sha384 = bundle.sha384,
                    requestedCapabilities = stored.requestedCapabilities.map { it.label }, keptGrants = kept.map { it.label },
                )
                audit.record(
                    if (existing == null) events.created(PLUGIN, stored.id, after = stored.auditView(), details = details)
                    else events.updated(PLUGIN, stored.id, before = existing.auditView(), after = stored.auditView(), details = details),
                )
                stored
            }
        }
    }

    /** Everything an install stores, read from the upload: refused with the matching 400 before any row is touched. */
    private fun readBundle(zip: ByteArray): Bundle {
        val unpacked = archive.unpack(zip)
        val manifest = readManifest(unpacked.files)
        val entryBytes = unpacked.files.getValue(manifest.entry)
        return Bundle(
            manifest = manifest,
            sha256 = hex(digest("SHA-256", zip)),
            sha384 = hex(digest("SHA-384", zip)),
            integrity = "sha384-" + Base64.getEncoder().encodeToString(digest("SHA-384", entryBytes)),
            files = unpacked.files.map { (path, data) -> BundleFile(path, PluginAssets.mediaTypeOf(path), data) },
        )
    }

    private class Bundle(
        val manifest: Manifest,
        val sha256: String,
        val sha384: String,
        val integrity: String,
        val files: List<BundleFile>,
    )

    /** The manifest of the archive: found, parsed, valid, and its entry file present - or the matching 400. */
    private fun readManifest(files: Map<String, ByteArray>): Manifest {
        val tree = parseManifest(files[MANIFEST_FILE] ?: refuse(ArchiveProblem.MANIFEST_MISSING))
        // the entry file is an archive problem (400 PLUGINS_ARCHIVE_INVALID), checked before the schema as the contract orders it
        val entry = tree.path("entry").takeIf { it.isString }?.stringValue()
        if (entry != null && entry !in files) refuse(ArchiveProblem.ENTRY_MISSING, entry)
        return when (val result = ManifestValidator.validate(tree)) {
            is ManifestResult.Valid -> result.manifest
            is ManifestResult.Invalid -> throw ManifestInvalidException(result.violations)
        }
    }

    /**
     * Two installed plugins never share a block type or an id that is a dot-prefix of the other (`a.b` next to `a.b.c`,
     * M3 review MUST 1, S3.8): else one could claim the namespace of the other. The plugin's own earlier version is no rival.
     */
    private fun requireNamespaceFree(manifest: Manifest, installed: List<InstalledPlugin>) {
        val others = installed.filter { it.id != manifest.id }
        val problems = mutableListOf<InvalidField>()
        others.firstOrNull { it.id.startsWith("${manifest.id}.") || manifest.id.startsWith("${it.id}.") }?.let {
            problems += InvalidField("id", "Namespace", "overlaps the namespace of the installed plugin '${it.id}'")
        }
        manifest.blockTypes.forEachIndexed { index, def ->
            others.firstOrNull { other -> other.blockTypes.any { it.type == def.type } }?.let {
                problems += InvalidField("blockTypes[$index].type", "Unique", "is a block type of the installed plugin '${it.id}'")
            }
        }
        if (problems.isNotEmpty()) throw ManifestInvalidException(problems)
    }

    private fun parseManifest(bytes: ByteArray): JsonNode = try {
        json.readTree(bytes)
    } catch (_: JacksonException) {
        throw ManifestInvalidException(listOf(InvalidField("$", "Syntax", "is not valid JSON")))
    }

    private fun isNewer(version: String, installed: String): Boolean {
        val candidate = checkNotNull(SemVer.parseOrNull(version)) { "the validator accepted version $version" }
        val current = SemVer.parseOrNull(installed) ?: return true
        return candidate > current
    }

    @WithSpan
    override suspend fun update(command: UpdatePluginCommand): InstalledPlugin = transactions.required {
        val current = plugins.findById(command.pluginId) ?: throw notFound(command.pluginId)
        if (current.revision != command.revision) throw conflict(current)
        val grants = command.grantedCapabilities.distinct()
        grants.firstOrNull { it !in current.requestedCapabilities }?.let {
            throw DomainException(ErrorCode.PLUGINS_CAPABILITY_NOT_REQUESTED, mapOf("capability" to it.label))
        }
        val ordered = current.requestedCapabilities.filter { it in grants } // one stable order, whatever the client sent
        if (current.enabled == command.enabled && current.grantedCapabilities == ordered) return@required current
        val updated = plugins.update(current.copy(enabled = command.enabled, grantedCapabilities = ordered)) ?: throw conflict(current)
        if (current.enabled != command.enabled) {
            audit.record(
                events.of(
                    PLUGIN, updated.id, AuditAction.UPDATED, if (updated.enabled) "enabled" else "disabled",
                    PluginSwitched(updated.version, updated.enabled, updated.bundleSha384),
                    before = current.auditView(), after = updated.auditView(),
                ),
            )
        }
        if (current.grantedCapabilities != ordered) {
            audit.record(
                events.of(
                    PLUGIN, updated.id, AuditAction.UPDATED, "grants-changed",
                    PluginGrantsChanged(updated.version, current.grantedCapabilities.map { it.label }, ordered.map { it.label }),
                ),
            )
        }
        updated
    }

    @WithSpan
    override suspend fun remove(@SpanAttribute("plugin.id") pluginId: String) {
        transactions.required {
            val current = plugins.findById(pluginId) ?: throw notFound(pluginId)
            bundles.deleteAll(pluginId)
            storage.deleteByPlugin(pluginId)
            plugins.delete(pluginId)
            audit.record(
                events.deleted(
                    PLUGIN,
                    pluginId,
                    before = current.auditView(),
                    details = PluginRemoved(current.version, current.bundleSha384),
                ),
            )
        }
    }

    @WithSpan
    override fun assetBase(plugin: InstalledPlugin): String = settings.assetBase(plugin.assetPath)

    @WithSpan
    override suspend fun listEnabled(principalId: Uuid): List<EnabledPlugin> = plugins.findEnabled().map {
        EnabledPlugin(
            id = it.id, version = it.version, assetBase = settings.assetBase(it.assetPath), entry = it.entry, integrity = it.integrity,
            blockTypes = it.blockTypes, grantedCapabilities = it.grantedCapabilities, userPseudonym = pseudonyms.of(principalId, it.id),
        )
    }

    @WithSpan
    override suspend fun readStorage(boardId: Uuid, @SpanAttribute("plugin.id") pluginId: String): PluginStorageData {
        requireStorage(pluginId)
        return storage.find(boardId, pluginId) ?: PluginStorageData(EMPTY_OBJECT, 0)
    }

    @WithSpan
    override suspend fun writeStorage(command: WriteStorageCommand): PluginStorageData {
        // 1 MiB a write: counted per user and board before anything is read or checked, 429 over the rate (M3 review, SHOULD 5)
        storageWrites.take("${command.writerId}|${command.boardId}")
        requireStorage(command.pluginId)
        if (command.json.toByteArray(Charsets.UTF_8).size > MAX_STORAGE_BYTES) throw PayloadTooLargeException(MAX_STORAGE_BYTES.toLong())
        val now = clock.now()
        val written = if (command.version == 0L) {
            storage.insert(command.boardId, command.pluginId, command.json, now)
        } else {
            storage.update(command.boardId, command.pluginId, command.json, command.version, now)
        }
        if (!written) {
            val current = storage.find(command.boardId, command.pluginId)?.version ?: 0
            throw DomainException(ErrorCode.CONFLICT, mapOf("pluginId" to command.pluginId, "currentVersion" to current.toString()))
        }
        return PluginStorageData(command.json, command.version + 1)
    }

    /** The plugin must be enabled (else 404, as if it did not exist) and have `storage` granted (else 403). */
    private suspend fun requireStorage(pluginId: String) {
        val plugin = plugins.findById(pluginId)?.takeIf { it.enabled } ?: throw notFound(pluginId)
        if (plugin.grantedCapabilities.none { it.name == "storage" }) throw DomainException(ErrorCode.FORBIDDEN)
    }

    @WithSpan
    override suspend fun serve(
        @SpanAttribute("plugin.id") pluginId: String,
        version: String,
        sha256: String,
        path: String,
    ): ServedAsset? {
        val plugin = plugins.findById(pluginId)?.takeIf { it.enabled && it.version == version && it.bundleSha256 == sha256 } ?: return null
        if (path == PluginAssets.FRAME_PATH) {
            return ServedAsset.Frame(
                FrameDocuments.create(plugin, settings.assetOrigin, settings.assetBase(plugin.assetPath), settings.appOrigin),
            )
        }
        if (path.startsWith(PluginArchive.RESERVED_PREFIX)) return null
        return bundles.find(plugin.id, plugin.bundleSha256, path)?.let { ServedAsset.File(it) }
    }

    @WithSpan
    override suspend fun deleteBoardData(boardIds: Collection<Uuid>) {
        if (boardIds.isNotEmpty()) storage.deleteByBoards(boardIds)
    }

    private fun notFound(pluginId: String) = DomainException(ErrorCode.PLUGINS_PLUGIN_NOT_FOUND, mapOf("pluginId" to pluginId))

    private fun conflict(plugin: InstalledPlugin) =
        DomainException(ErrorCode.CONFLICT, mapOf("pluginId" to plugin.id, "currentRevision" to plugin.revision.toString()))

    private fun digest(algorithm: String, bytes: ByteArray) = MessageDigest.getInstance(algorithm).digest(bytes)

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /** What the audit event keeps of a plugin: its identity and state, not its files. */
    private fun InstalledPlugin.auditView() = mapOf(
        "version" to version, "enabled" to enabled, "bundleSha384" to bundleSha384,
        "granted" to grantedCapabilities.map(Capability::label), "requested" to requestedCapabilities.map(Capability::label),
    )

    private companion object {
        const val PLUGIN = "plugin"
        const val MANIFEST_FILE = "drawboard-plugin.json"
        const val EMPTY_OBJECT = "{}"
        const val MAX_STORAGE_BYTES = 1_048_576
    }
}
