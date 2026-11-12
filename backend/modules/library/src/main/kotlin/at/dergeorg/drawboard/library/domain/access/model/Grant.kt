package at.dergeorg.drawboard.library.domain.access.model

import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Who a grant is for. Same names as `MemberPrincipalKind` of the API contract. */
enum class PrincipalKind {
    /** One user, by the application's own user id. */
    USER,

    /** Everybody whose current access token carries this group (S6.5). */
    GROUP,

    /** A user who opened a share link while signed in; the grant lives as long as the link ([Grant.linkId]) does. */
    LINK_USER,
}

/**
 * The right of a principal on a board or folder. A grant on a folder applies to everything below it; the strongest
 * role wins. The owner is never a grant, and neither is the role `OWNER` ([role] is below it).
 * [principal] is the user id as text (USER, LINK_USER) or the group name (GROUP).
 */
data class Grant(
    val id: Uuid,
    val resourceKind: ResourceKind,
    val resourceId: Uuid,
    val principalKind: PrincipalKind,
    val principal: String,
    val role: BoardRole,
    /** The share link a LINK_USER grant came from; revoking the link removes the grant. */
    val linkId: Uuid?,
    val createdAt: Instant,
    val updatedAt: Instant,
) {
    init {
        require(role != BoardRole.OWNER) { "OWNER is never granted" }
    }
}
