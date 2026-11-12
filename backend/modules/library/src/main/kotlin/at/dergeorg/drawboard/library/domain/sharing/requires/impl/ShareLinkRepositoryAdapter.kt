package at.dergeorg.drawboard.library.domain.sharing.requires.impl

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Criteria
import org.springframework.data.relational.core.query.Query
import org.springframework.data.relational.core.query.Update
import org.springframework.stereotype.Repository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the domain's [ShareLinkRepository] port with Spring Data R2DBC. */
@Repository
internal class ShareLinkRepositoryAdapter(
    private val links: ShareLinkR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : ShareLinkRepository {

    @WithSpan
    override suspend fun insert(link: ShareLink): ShareLink = template.insert(link.toEntity()).awaitSingle().toDomain()

    @WithSpan
    override suspend fun findById(id: Uuid): ShareLink? = links.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findByTokenHash(hash: String): ShareLink? = links.findByTokenHash(hash)?.toDomain()

    @WithSpan
    override suspend fun findByResource(kind: ResourceKind, resourceId: Uuid): List<ShareLink> =
        links.findAllByResourceKindAndResourceIdOrderByCreatedAtDesc(kind.name, resourceId).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<ShareLink> =
        if (ids.isEmpty()) emptyList() else links.findAllById(ids).map { it.toDomain() }.toList()

    /** `UPDATE … SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`: the first revocation wins, the time stays. */
    @WithSpan
    override suspend fun revoke(id: Uuid, at: Instant): Boolean =
        template.update(ShareLinkEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(id).and("revokedAt").isNull))
            .apply(Update.update("revokedAt", at))
            .awaitSingle() > 0

    /** A targeted increment is not possible without SQL; the count is read and written back - a lost update at most miscounts. */
    @WithSpan
    override suspend fun incrementUseCount(id: Uuid) {
        val stored = links.findById(id) ?: return
        template.update(ShareLinkEntity::class.java)
            .matching(Query.query(Criteria.where("id").`is`(id)))
            .apply(Update.update("useCount", stored.useCount + 1))
            .awaitSingle()
    }

    @WithSpan
    override suspend fun deleteByResources(kind: ResourceKind, ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) links.deleteByResourceKindAndResourceIdIn(kind.name, ids)
    }

    @WithSpan
    override suspend fun countUsable(audience: ShareAudience, now: Instant): Long =
        links.countByAudienceAndRevokedAtIsNullAndExpiresAtIsNull(audience.name) +
            links.countByAudienceAndRevokedAtIsNullAndExpiresAtAfter(audience.name, now)
}
