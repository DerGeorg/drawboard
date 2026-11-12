package at.dergeorg.drawboard.library.domain.access.model

import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import kotlin.uuid.Uuid

/** What a share link points at. Same names as `ShareResourceKind` of the API contract. */
enum class ResourceKind { BOARD, FOLDER }

/**
 * Who asks, as the library needs to know it to decide about access (S1.7: guests are their own kind of caller and
 * authorisation branches on the type). Built by the api module from the token of the request - the library never sees
 * tokens.
 */
sealed interface Caller {

    /**
     * A signed-in user: the application's own [id] and the groups of the CURRENT access token (S6.5) - never groups
     * stored with the profile.
     */
    data class User(val id: Uuid, val groups: Set<String> = emptySet()) : Caller

    /**
     * A guest of a share link: reaches only the [kind] resource [resourceId] and what lies below it, with the role
     * of the share ([role], never owner), and only while the share [shareId] is valid.
     */
    data class Guest(val shareId: Uuid, val kind: ResourceKind, val resourceId: Uuid, val role: BoardRole) : Caller
}
