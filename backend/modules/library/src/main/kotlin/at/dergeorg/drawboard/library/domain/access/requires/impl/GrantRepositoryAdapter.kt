package at.dergeorg.drawboard.library.domain.access.requires.impl

import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.stereotype.Repository
import kotlin.uuid.Uuid

/** Implements the domain's [GrantRepository] port with Spring Data R2DBC. */
@Repository
internal class GrantRepositoryAdapter(
    private val grants: GrantR2dbcRepository,
    private val template: R2dbcEntityTemplate,
) : GrantRepository {

    @WithSpan
    override suspend fun findByResources(kind: ResourceKind, ids: Collection<Uuid>): List<Grant> =
        if (ids.isEmpty()) emptyList() else grants.findAllByResourceKindAndResourceIdIn(kind.name, ids).map { it.toDomain() }.toList()

    @WithSpan
    override suspend fun findForPrincipal(userId: Uuid, groups: Collection<String>): List<Grant> {
        val direct = grants.findAllByPrincipalKindInAndPrincipal(
            listOf(PrincipalKind.USER.name, PrincipalKind.LINK_USER.name),
            userId.toString(),
        ).map { it.toDomain() }.toList()
        val byGroup = if (groups.isEmpty()) {
            emptyList()
        } else {
            grants.findAllByPrincipalKindAndPrincipalIn(PrincipalKind.GROUP.name, groups).map { it.toDomain() }.toList()
        }
        return direct + byGroup
    }

    /** Delete, then insert: the unique key is (resource, principal kind, principal); both run in the caller's transaction. */
    @WithSpan
    override suspend fun put(grant: Grant) {
        remove(grant.resourceKind, grant.resourceId, grant.principalKind, grant.principal)
        template.insert(grant.toEntity()).awaitSingle()
    }

    @WithSpan
    override suspend fun remove(kind: ResourceKind, resourceId: Uuid, principalKind: PrincipalKind, principal: String): Boolean =
        grants.deleteByResourceKindAndResourceIdAndPrincipalKindAndPrincipal(kind.name, resourceId, principalKind.name, principal) > 0

    @WithSpan
    override suspend fun removeByResources(kind: ResourceKind, ids: Collection<Uuid>) {
        if (ids.isNotEmpty()) grants.deleteByResourceKindAndResourceIdIn(kind.name, ids)
    }

    @WithSpan
    override suspend fun removeByLink(linkId: Uuid) {
        grants.deleteByLinkId(linkId)
    }
}
