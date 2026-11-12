package at.dergeorg.drawboard.library.domain.access.requires

import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import kotlin.uuid.Uuid

/** Persistence port of grants, in domain terms only. Implemented in requires/impl (Spring Data R2DBC). */
internal interface GrantRepository {

    /** The grants on any of the [resources] (kind + id), e.g. a board and the folders above it. */
    suspend fun findByResources(kind: ResourceKind, ids: Collection<Uuid>): List<Grant>

    /** Every grant of the user (USER and LINK_USER) and of the groups - for "shared with me". */
    suspend fun findForPrincipal(userId: Uuid, groups: Collection<String>): List<Grant>

    /** Inserts the grant, replacing the one of the same principal on the same resource. */
    suspend fun put(grant: Grant)

    /** Removes the grant of [principal] on the resource; true if there was one. */
    suspend fun remove(kind: ResourceKind, resourceId: Uuid, principalKind: PrincipalKind, principal: String): Boolean

    suspend fun removeByResources(kind: ResourceKind, ids: Collection<Uuid>)

    /** Removes the LINK_USER grants that came from [linkId]. */
    suspend fun removeByLink(linkId: Uuid)
}
