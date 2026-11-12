package at.dergeorg.drawboard.library.domain.access.requires.impl

import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `library.grant_entry`. Only used inside requires/impl; the domain sees [Grant]. Inserted, never `save()`d. */
@Table(schema = "library", name = "grant_entry")
internal data class GrantEntity(
    @Id val id: Uuid,
    val resourceKind: String,
    val resourceId: Uuid,
    val principalKind: String,
    val principal: String,
    val role: String,
    val linkId: Uuid?,
    val createdAt: Instant,
    val updatedAt: Instant,
)

internal fun GrantEntity.toDomain() = Grant(
    id = id,
    resourceKind = ResourceKind.valueOf(resourceKind),
    resourceId = resourceId,
    principalKind = PrincipalKind.valueOf(principalKind),
    principal = principal,
    role = BoardRole.valueOf(role),
    linkId = linkId,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

internal fun Grant.toEntity() = GrantEntity(
    id = id,
    resourceKind = resourceKind.name,
    resourceId = resourceId,
    principalKind = principalKind.name,
    principal = principal,
    role = role.name,
    linkId = linkId,
    createdAt = createdAt,
    updatedAt = updatedAt,
)
