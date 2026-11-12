package at.dergeorg.drawboard.library.domain.sharing.requires.impl

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `library.share_link`. Only used inside requires/impl; the domain sees [ShareLink]. Inserted, never `save()`d. */
@Table(schema = "library", name = "share_link")
internal data class ShareLinkEntity(
    @Id val id: Uuid,
    val resourceKind: String,
    val resourceId: Uuid,
    val role: String,
    val audience: String,
    val tokenHash: String,
    val passwordHash: String?,
    val expiresAt: Instant?,
    val revokedAt: Instant?,
    val useCount: Long,
    val createdAt: Instant,
    val createdBy: Uuid,
)

internal fun ShareLinkEntity.toDomain() = ShareLink(
    id = id,
    resourceKind = ResourceKind.valueOf(resourceKind),
    resourceId = resourceId,
    role = BoardRole.valueOf(role),
    audience = ShareAudience.valueOf(audience),
    tokenHash = tokenHash,
    passwordHash = passwordHash,
    expiresAt = expiresAt,
    revokedAt = revokedAt,
    useCount = useCount,
    createdAt = createdAt,
    createdBy = createdBy,
)

internal fun ShareLink.toEntity() = ShareLinkEntity(
    id = id,
    resourceKind = resourceKind.name,
    resourceId = resourceId,
    role = role.name,
    audience = audience.name,
    tokenHash = tokenHash,
    passwordHash = passwordHash,
    expiresAt = expiresAt,
    revokedAt = revokedAt,
    useCount = useCount,
    createdAt = createdAt,
    createdBy = createdBy,
)
