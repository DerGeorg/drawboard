package at.dergeorg.drawboard.plugins.domain.plugins.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.uuid.Uuid

/** Spring Data R2DBC repositories, derived queries only. Used by the adapters in this package only. */
internal interface PluginR2dbcRepository : CoroutineCrudRepository<PluginEntity, String> {

    fun findAllByOrderByIdAsc(): Flow<PluginEntity>

    fun findAllByEnabledTrueOrderByIdAsc(): Flow<PluginEntity>
}

internal interface PluginFileR2dbcRepository : CoroutineCrudRepository<PluginFileEntity, Uuid> {

    suspend fun findByPluginIdAndBundleSha256AndPath(pluginId: String, bundleSha256: String, path: String): PluginFileEntity?

    suspend fun deleteByPluginIdAndBundleSha256(pluginId: String, bundleSha256: String): Long

    suspend fun deleteByPluginId(pluginId: String): Long
}

internal interface PluginStorageR2dbcRepository : CoroutineCrudRepository<PluginStorageEntity, Uuid> {

    suspend fun findByBoardIdAndPluginId(boardId: Uuid, pluginId: String): PluginStorageEntity?

    suspend fun deleteByBoardIdIn(boardIds: Collection<Uuid>): Long

    suspend fun deleteByPluginId(pluginId: String): Long
}
