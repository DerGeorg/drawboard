package at.dergeorg.drawboard.library.domain.access.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.uuid.Uuid

/** Spring Data R2DBC repository of grants, derived queries only. Only [GrantRepositoryAdapter] uses it. */
internal interface GrantR2dbcRepository : CoroutineCrudRepository<GrantEntity, Uuid> {

    fun findAllByResourceKindAndResourceIdIn(resourceKind: String, resourceIds: Collection<Uuid>): Flow<GrantEntity>

    fun findAllByPrincipalKindInAndPrincipal(principalKinds: Collection<String>, principal: String): Flow<GrantEntity>

    fun findAllByPrincipalKindAndPrincipalIn(principalKind: String, principals: Collection<String>): Flow<GrantEntity>

    suspend fun deleteByResourceKindAndResourceIdAndPrincipalKindAndPrincipal(
        resourceKind: String,
        resourceId: Uuid,
        principalKind: String,
        principal: String,
    ): Long

    suspend fun deleteByResourceKindAndResourceIdIn(resourceKind: String, resourceIds: Collection<Uuid>): Long

    suspend fun deleteByLinkId(linkId: Uuid): Long
}
