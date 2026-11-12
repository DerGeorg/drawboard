package at.dergeorg.drawboard.library.domain.sharing.provides

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.model.MembersView
import at.dergeorg.drawboard.library.domain.sharing.model.SharedView
import kotlin.uuid.Uuid

/**
 * Who may use a board or folder besides its owner: grants for users and groups. Reading the members needs any role on
 * the resource, changing them the role `OWNER`; a caller without a role gets "not found". Every change is audited.
 * The users module is not known here: the caller checks that a user exists and adds display names.
 */
interface MembersUseCase {

    suspend fun listMembers(caller: Caller, kind: ResourceKind, resourceId: Uuid): MembersView

    /** Creates or changes the grant of a user. The owner cannot be a member (`VALIDATION_FAILED` on `userId`). */
    suspend fun setUserMember(command: SetMemberCommand)

    /** Creates or changes the grant of a group (matched against the groups of the member's current token). */
    suspend fun setGroupMember(command: SetMemberCommand)

    suspend fun removeUserMember(caller: Caller, kind: ResourceKind, resourceId: Uuid, userId: Uuid)

    suspend fun removeGroupMember(caller: Caller, kind: ResourceKind, resourceId: Uuid, group: String)

    /** Boards and folders others shared with the caller directly; trash excluded. Not for guests. */
    suspend fun listSharedWithMe(caller: Caller): SharedView
}

/** [principal] is the user id or the group name; [role] is never `OWNER`. */
data class SetMemberCommand(
    val caller: Caller,
    val kind: ResourceKind,
    val resourceId: Uuid,
    val principal: String,
    val role: BoardRole,
)
