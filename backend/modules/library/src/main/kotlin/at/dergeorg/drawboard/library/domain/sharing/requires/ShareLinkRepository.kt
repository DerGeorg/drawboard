package at.dergeorg.drawboard.library.domain.sharing.requires

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Persistence port of share links, in domain terms only. Implemented in requires/impl (Spring Data R2DBC). */
internal interface ShareLinkRepository {

    suspend fun insert(link: ShareLink): ShareLink

    suspend fun findById(id: Uuid): ShareLink?

    /** The link whose token has this sha256 hash (lowercase hex), if any. */
    suspend fun findByTokenHash(hash: String): ShareLink?

    suspend fun findByResource(kind: ResourceKind, resourceId: Uuid): List<ShareLink>

    suspend fun findAllById(ids: Collection<Uuid>): List<ShareLink>

    /** Sets `revokedAt` unless the link is revoked already; true if this call revoked it. */
    suspend fun revoke(id: Uuid, at: Instant): Boolean

    suspend fun incrementUseCount(id: Uuid)

    suspend fun deleteByResources(kind: ResourceKind, ids: Collection<Uuid>)

    /** Links that are neither revoked nor expired at [now], by audience - for the gauge. */
    suspend fun countUsable(audience: ShareAudience, now: Instant): Long
}
