package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import kotlin.uuid.Uuid

/** Fake of the internal [GrantRepository] port. */
internal class InMemoryGrantRepository(vararg initial: Grant) : GrantRepository {
    private val grants = initial.toMutableList()

    val all: List<Grant> get() = grants.toList()

    override suspend fun findByResources(kind: ResourceKind, ids: Collection<Uuid>) =
        grants.filter { it.resourceKind == kind && it.resourceId in ids }

    override suspend fun findForPrincipal(userId: Uuid, groups: Collection<String>) = grants.filter {
        (it.principalKind != PrincipalKind.GROUP && it.principal == userId.toString()) ||
            (it.principalKind == PrincipalKind.GROUP && it.principal in groups)
    }

    override suspend fun put(grant: Grant) {
        remove(grant.resourceKind, grant.resourceId, grant.principalKind, grant.principal)
        grants += grant
    }

    override suspend fun remove(kind: ResourceKind, resourceId: Uuid, principalKind: PrincipalKind, principal: String) =
        grants.removeAll {
            it.resourceKind == kind && it.resourceId == resourceId && it.principalKind == principalKind && it.principal == principal
        }

    override suspend fun removeByResources(kind: ResourceKind, ids: Collection<Uuid>) {
        grants.removeAll { it.resourceKind == kind && it.resourceId in ids }
    }

    override suspend fun removeByLink(linkId: Uuid) {
        grants.removeAll { it.linkId == linkId }
    }
}
