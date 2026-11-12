package at.dergeorg.drawboard.library.domain.sharing.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Spring Data R2DBC repository of share links, derived queries only. Only [ShareLinkRepositoryAdapter] uses it. */
internal interface ShareLinkR2dbcRepository : CoroutineCrudRepository<ShareLinkEntity, Uuid> {

    suspend fun findByTokenHash(tokenHash: String): ShareLinkEntity?

    fun findAllByResourceKindAndResourceIdOrderByCreatedAtDesc(resourceKind: String, resourceId: Uuid): Flow<ShareLinkEntity>

    suspend fun deleteByResourceKindAndResourceIdIn(resourceKind: String, resourceIds: Collection<Uuid>): Long

    suspend fun countByAudienceAndRevokedAtIsNullAndExpiresAtIsNull(audience: String): Long

    suspend fun countByAudienceAndRevokedAtIsNullAndExpiresAtAfter(audience: String, now: Instant): Long
}
