package at.dergeorg.drawboard.plugins.domain.plugins.requires.impl

import at.dergeorg.drawboard.plugins.domain.plugins.model.BlockTypeDef
import at.dergeorg.drawboard.plugins.domain.plugins.model.Capability
import at.dergeorg.drawboard.plugins.domain.plugins.model.InstalledPlugin
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginAsset
import at.dergeorg.drawboard.plugins.domain.plugins.model.PluginStorageData
import at.dergeorg.drawboard.plugins.domain.plugins.requires.BundleFile
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginFileRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.PluginStorageRepository
import at.dergeorg.drawboard.plugins.domain.plugins.requires.Transactions
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.data.relational.core.query.Update
import org.springframework.stereotype.Component
import org.springframework.stereotype.Repository
import org.springframework.transaction.reactive.TransactionalOperator
import org.springframework.transaction.reactive.executeAndAwait
import tools.jackson.databind.json.JsonMapper
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the domain's [PluginRepository] port with Spring Data R2DBC; the lists of the manifest are kept as JSON text. */
@Repository
internal class PluginRepositoryAdapter(
    private val plugins: PluginR2dbcRepository,
    private val json: JsonMapper,
) : PluginRepository {

    @WithSpan
    override suspend fun findById(id: String): InstalledPlugin? = plugins.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findAll(): List<InstalledPlugin> = plugins.findAllByOrderByIdAsc().map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findEnabled(): List<InstalledPlugin> = plugins.findAllByEnabledTrueOrderByIdAsc().map { it.toDomain() }.toList()

    /** A null revision makes `save()` INSERT - the id is already set, Spring Data cannot tell "new" from it. */
    @WithSpan
    override suspend fun insert(plugin: InstalledPlugin): InstalledPlugin = plugins.save(plugin.toEntity(revision = null)).toDomain()

    @WithSpan
    override suspend fun update(plugin: InstalledPlugin): InstalledPlugin? = try {
        plugins.save(plugin.toEntity(revision = plugin.revision)).toDomain()
    } catch (_: OptimisticLockingFailureException) {
        null
    }

    @WithSpan
    override suspend fun delete(id: String) {
        plugins.deleteById(id)
    }

    private fun PluginEntity.toDomain() = InstalledPlugin(
        id = id, name = name, version = version, description = description, enabled = enabled, installedAt = installedAt,
        installedBy = installedBy, bundleSha256 = bundleSha256, bundleSha384 = bundleSha384, entry = entry, integrity = integrity,
        blockTypes = json.readValue(blockTypes, json.typeFactory.constructCollectionType(List::class.java, BlockTypeDef::class.java)),
        requestedCapabilities = json.readValue(
            requestedCapabilities,
            json.typeFactory.constructCollectionType(List::class.java, Capability::class.java),
        ),
        grantedCapabilities = json.readValue(
            grantedCapabilities,
            json.typeFactory.constructCollectionType(List::class.java, Capability::class.java),
        ),
        revision = revision,
    )

    private fun InstalledPlugin.toEntity(revision: Long?) = PluginEntity(
        id = id, name = name, version = version, description = description, enabled = enabled, installedAt = installedAt,
        installedBy = installedBy, bundleSha256 = bundleSha256, bundleSha384 = bundleSha384, entry = entry, integrity = integrity,
        blockTypes = json.writeValueAsString(blockTypes),
        requestedCapabilities = json.writeValueAsString(requestedCapabilities),
        grantedCapabilities = json.writeValueAsString(grantedCapabilities),
        revision = revision,
    )
}

/** Implements the domain's [PluginFileRepository] port: the entry list of an install is the set of rows with its hash. */
@Repository
internal class PluginFileRepositoryAdapter(
    private val files: PluginFileR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : PluginFileRepository {

    @WithSpan
    override suspend fun insertAll(pluginId: String, bundleSha256: String, files: List<BundleFile>) {
        files.forEach {
            template.insert(
                PluginFileEntity(Uuid.generateV7(), pluginId, bundleSha256, it.path, it.mediaType, it.data.size.toLong(), it.data),
            ).awaitSingle()
        }
    }

    @WithSpan
    override suspend fun find(pluginId: String, bundleSha256: String, path: String): PluginAsset? =
        files.findByPluginIdAndBundleSha256AndPath(pluginId, bundleSha256, path)?.let { PluginAsset(it.path, it.mediaType, it.data) }

    @WithSpan
    override suspend fun deleteBundle(pluginId: String, bundleSha256: String) {
        files.deleteByPluginIdAndBundleSha256(pluginId, bundleSha256)
    }

    @WithSpan
    override suspend fun deleteAll(pluginId: String) {
        files.deleteByPluginId(pluginId)
    }
}

/** Implements the domain's [PluginStorageRepository] port; the version check of a write is a conditional UPDATE. */
@Repository
internal class PluginStorageRepositoryAdapter(
    private val storage: PluginStorageR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : PluginStorageRepository {

    @WithSpan
    override suspend fun find(boardId: Uuid, pluginId: String): PluginStorageData? =
        storage.findByBoardIdAndPluginId(boardId, pluginId)?.let { PluginStorageData(it.data, it.version) }

    @WithSpan
    override suspend fun insert(boardId: Uuid, pluginId: String, json: String, at: Instant): Boolean = try {
        template.insert(PluginStorageEntity(Uuid.generateV7(), boardId, pluginId, json, version = 1, updatedAt = at)).awaitSingle()
        true
    } catch (_: DataIntegrityViolationException) {
        false // the unique key (board, plugin): another first write came first
    }

    @WithSpan
    override suspend fun update(boardId: Uuid, pluginId: String, json: String, expectedVersion: Long, at: Instant): Boolean {
        val rows = template.update(PluginStorageEntity::class.java)
            .matching(
                Query.query(Criteria.where("boardId").`is`(boardId).and("pluginId").`is`(pluginId).and("version").`is`(expectedVersion)),
            )
            .apply(Update.update("data", json).set("version", expectedVersion + 1).set("updatedAt", at))
            .awaitSingle()
        return rows > 0
    }

    @WithSpan
    override suspend fun deleteByBoards(boardIds: Collection<Uuid>) {
        storage.deleteByBoardIdIn(boardIds)
    }

    @WithSpan
    override suspend fun deleteByPlugin(pluginId: String) {
        storage.deleteByPluginId(pluginId)
    }
}

/** The [Transactions] port on the reactive transaction manager: REQUIRED, like `@Transactional`. */
@Component
internal class PluginTransactions(private val operator: TransactionalOperator) : Transactions {

    @Suppress("UNCHECKED_CAST")
    override suspend fun <T> required(block: suspend () -> T): T = operator.executeAndAwait { block() } as T
}
