package at.dergeorg.drawboard.collab.domain.rooms.model

import kotlin.uuid.Uuid

/**
 * Who sits in a session, as far as the access check needs it: the application's user id, the groups of the access token
 * the ticket was issued with (S6.5: group grants are evaluated against the token, not against stored groups), and for a
 * guest the id of the share link they came through ([shareId] set = guest; [userId] is then the id minted for the
 * guest session, `guest:<id>` in the token).
 */
data class Participant(val userId: Uuid, val groups: Set<String> = emptySet(), val shareId: Uuid? = null) {
    val guest: Boolean get() = shareId != null
}
