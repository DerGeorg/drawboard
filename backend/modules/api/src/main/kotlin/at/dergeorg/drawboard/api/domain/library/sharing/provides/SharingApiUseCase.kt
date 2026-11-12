package at.dergeorg.drawboard.api.domain.library.sharing.provides

import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.ShareRefresh
import at.dergeorg.drawboard.contract.model.Member
import at.dergeorg.drawboard.contract.model.MemberList
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.ShareLinkList
import at.dergeorg.drawboard.contract.model.SharedWithMe
import at.dergeorg.drawboard.contract.model.ShareResourceKind
import kotlin.uuid.Uuid

/** The sharing part of the API in contract types: members and "shared with me" and share links. */
interface SharingApiUseCase {

    suspend fun listMembers(kind: ShareResourceKind, resourceId: Uuid): MemberList

    suspend fun setUserMember(kind: ShareResourceKind, resourceId: Uuid, userId: Uuid, role: GrantRole): Member

    suspend fun setGroupMember(kind: ShareResourceKind, resourceId: Uuid, group: String, role: GrantRole): Member

    suspend fun removeUserMember(kind: ShareResourceKind, resourceId: Uuid, userId: Uuid)

    suspend fun removeGroupMember(kind: ShareResourceKind, resourceId: Uuid, group: String)

    suspend fun listSharedWithMe(): SharedWithMe

    suspend fun listLinks(kind: ShareResourceKind, resourceId: Uuid): ShareLinkList

    suspend fun createLink(kind: ShareResourceKind, resourceId: Uuid, newShareLink: NewShareLink): CreatedShareLink

    suspend fun revokeLink(linkId: Uuid)

    /** Opens a link: signed-in callers get the role remembered; anonymous ones a guest session where allowed. */
    suspend fun exchange(request: ShareExchange): ShareAccess

    /** Renews the guest session of the calling guest (S1.4); needs the token of the link again. */
    suspend fun refresh(request: ShareRefresh): GuestSession
}
