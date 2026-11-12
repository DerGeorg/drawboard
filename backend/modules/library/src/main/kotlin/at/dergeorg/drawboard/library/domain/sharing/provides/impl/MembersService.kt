package at.dergeorg.drawboard.library.domain.sharing.provides.impl

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.LibraryErrors
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import at.dergeorg.drawboard.library.domain.boards.BoardAccess
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.library.domain.sharing.model.AclChanged
import at.dergeorg.drawboard.library.domain.sharing.model.MemberEntry
import at.dergeorg.drawboard.library.domain.sharing.model.MembersView
import at.dergeorg.drawboard.library.domain.sharing.model.SharedView
import at.dergeorg.drawboard.library.domain.sharing.provides.MembersUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.SetMemberCommand
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.uuid.Uuid

/** Implements the member use cases: grants for users and groups on boards and folders. */
@Service
internal class MembersService(
    private val boards: BoardRepository,
    private val folders: FolderRepository,
    private val grants: GrantRepository,
    private val access: AccessResolver,
    private val audit: AuditTrail,
    private val clock: Clock,
) : MembersUseCase {

    private val events = DomainEvents(LibraryModule.NAME)

    /** What a use case knows about the resource it works on. */
    private data class Target(val ownerId: Uuid, val role: BoardRole, val parentFolderId: Uuid?)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listMembers(
        caller: Caller,
        kind: ResourceKind,
        @SpanAttribute("resource.id") resourceId: Uuid,
    ): MembersView {
        val target = target(caller, kind, resourceId)
        val entries = access.effectiveGrants(kind, resourceId, target.parentFolderId)
            .map { (grant, from) -> MemberEntry(grant, from) }
        val ordered = entries.sortedWith(compareBy({ it.inheritedFrom != null }, { it.grant.role }, { it.grant.principal }))
        return MembersView(target.ownerId, ordered)
    }

    @WithSpan
    @Transactional
    override suspend fun setUserMember(command: SetMemberCommand) = put(command, PrincipalKind.USER)

    @WithSpan
    @Transactional
    override suspend fun setGroupMember(command: SetMemberCommand) = put(command, PrincipalKind.GROUP)

    @WithSpan
    @Transactional
    override suspend fun removeUserMember(caller: Caller, kind: ResourceKind, resourceId: Uuid, userId: Uuid) =
        remove(caller, kind, resourceId, PrincipalKind.USER, userId.toString())

    @WithSpan
    @Transactional
    override suspend fun removeGroupMember(caller: Caller, kind: ResourceKind, resourceId: Uuid, group: String) =
        remove(caller, kind, resourceId, PrincipalKind.GROUP, group)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listSharedWithMe(caller: Caller): SharedView {
        val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
        val mine = grants.findForPrincipal(user.id, user.groups)
        val boardViews = boards.findAllById(mine.filter { it.resourceKind == ResourceKind.BOARD }.map { it.resourceId }.toSet())
            .mapNotNull { board -> access.boardRole(board, caller)?.let { BoardView(board, it) } }
            .sortedByDescending { it.board.updatedAt }
        val folderViews = folders.findAllById(mine.filter { it.resourceKind == ResourceKind.FOLDER }.map { it.resourceId }.toSet())
            .mapNotNull { folder -> access.folderRole(folder, caller)?.let { FolderView(folder, it) } }
            .sortedBy { it.folder.name.lowercase() }
        return SharedView(boardViews, folderViews)
    }

    private suspend fun put(command: SetMemberCommand, principalKind: PrincipalKind) {
        val principal = command.principal.trim()
        val target = ownerTarget(command.caller, command.kind, command.resourceId)
        if (command.role == BoardRole.OWNER) throw invalid("role", "must not be OWNER")
        if (principalKind == PrincipalKind.USER && principal == target.ownerId.toString()) {
            throw invalid("userId", "the owner cannot be a member")
        }
        if (principal.isEmpty()) throw invalid("group", "must not be blank")
        val now = clock.now()
        if (principalKind == PrincipalKind.USER) {
            // A link grant of this user becomes the direct grant: one right per user and resource.
            grants.remove(command.kind, command.resourceId, PrincipalKind.LINK_USER, principal)
        }
        grants.put(
            Grant(
                id = Uuid.generateV7(),
                resourceKind = command.kind,
                resourceId = command.resourceId,
                principalKind = principalKind,
                principal = principal,
                role = command.role,
                linkId = null,
                createdAt = now,
                updatedAt = now,
            ),
        )
        record(command.kind, command.resourceId, AclChanged(principalKind.name, principal, command.role.name))
    }

    private suspend fun remove(caller: Caller, kind: ResourceKind, resourceId: Uuid, principalKind: PrincipalKind, principal: String) {
        ownerTarget(caller, kind, resourceId)
        // Removing what is not there is not an error (DELETE is idempotent), but it is not an ACL change either.
        if (grants.remove(kind, resourceId, principalKind, principal)) {
            record(kind, resourceId, AclChanged(principalKind.name, principal, role = null))
        }
    }

    private suspend fun record(kind: ResourceKind, resourceId: Uuid, details: AclChanged) {
        audit.record(events.of(kind.name.lowercase(), resourceId, AuditAction.UPDATED, "acl-changed", details))
    }

    /** The resource with the caller's role: "not found" without any role. */
    private suspend fun target(caller: Caller, kind: ResourceKind, id: Uuid): Target = when (kind) {
        ResourceKind.BOARD -> {
            val board = boards.findById(id)?.takeIf { it.deletedAt == null } ?: throw LibraryErrors.boardNotFound(id)
            Target(board.ownerId, access.boardRole(board, caller) ?: throw LibraryErrors.boardNotFound(id), board.folderId)
        }
        ResourceKind.FOLDER -> {
            val folder = folders.findById(id)?.takeIf { it.deletedAt == null } ?: throw LibraryErrors.folderNotFound(id)
            Target(folder.ownerId, access.folderRole(folder, caller) ?: throw LibraryErrors.folderNotFound(id), folder.parentId)
        }
    }

    /** Like [target], and the caller must be the owner: any other role is 403. */
    private suspend fun ownerTarget(caller: Caller, kind: ResourceKind, id: Uuid): Target {
        val target = target(caller, kind, id)
        if (kind == ResourceKind.BOARD) BoardAccess.require(id, target.role, BoardAccess.CAN_DELETE)
        if (kind == ResourceKind.FOLDER && target.role != BoardRole.OWNER) throw DomainException(ErrorCode.FORBIDDEN)
        return target
    }

    private fun invalid(field: String, message: String) =
        ValidationFailedException(listOf(InvalidField(field = field, constraint = "Invalid", message = message)))
}
