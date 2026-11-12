package at.dergeorg.drawboard.library.domain.access

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import org.springframework.stereotype.Component
import kotlin.time.Clock
import kotlin.uuid.Uuid

/**
 * Who may do what with a board or a folder: the ONE place that turns a [Caller] into a role. Callers never look at
 * owners or grants themselves.
 *
 * * The owner is `OWNER` on everything in their space.
 * * A user gets the strongest role of the grants on the resource and on every folder above it (inheritance): a USER
 *   grant for their id, a GROUP grant for one of the groups of the CURRENT token (S6.5 - never stored groups), a
 *   LINK_USER grant they got through a share link.
 * * A guest gets the role of their share, and only on the resource the share points at or below it (S1.7).
 * * A board or folder in the trash has no role for anybody: it must look as if it did not exist (the trash use cases
 *   look at deleted items on their own).
 */
@Component
internal class AccessResolver(
    private val folders: FolderRepository,
    private val grants: GrantRepository,
    private val links: ShareLinkRepository,
    private val clock: Clock,
) {

    suspend fun boardRole(board: Board, caller: Caller): BoardRole? {
        if (board.deletedAt != null) return null
        val above = ancestorIds(board.folderId)
        return when (caller) {
            is Caller.User -> if (board.ownerId == caller.id) BoardRole.OWNER else userRole(caller, BOARD to board.id, above)
            is Caller.Guest -> guestRole(caller, board.id, ResourceKind.BOARD, above)
        }
    }

    suspend fun folderRole(folder: Folder, caller: Caller): BoardRole? {
        if (folder.deletedAt != null) return null
        val above = ancestorIds(folder.parentId)
        return when (caller) {
            is Caller.User -> if (folder.ownerId == caller.id) BoardRole.OWNER else userRole(caller, FOLDER to folder.id, above)
            is Caller.Guest -> guestRole(caller, folder.id, ResourceKind.FOLDER, above)
        }
    }

    /** The folders above [folderId] (itself first), nearest first - for inheritance and the cycle check. Bounded. */
    suspend fun ancestors(folderId: Uuid?): List<Folder> {
        val chain = ArrayList<Folder>()
        var next = folderId
        while (next != null && chain.size < MAX_DEPTH) {
            val folder = folders.findById(next) ?: break
            chain += folder
            next = folder.parentId
        }
        return chain
    }

    /**
     * The grants that apply to a board or folder: its own and those of the folders above it, each with the folder it
     * is inherited from (null = set on the resource itself).
     */
    suspend fun effectiveGrants(kind: ResourceKind, id: Uuid, parentFolderId: Uuid?): List<Pair<Grant, Uuid?>> {
        val above = ancestorIds(parentFolderId)
        val own = grants.findByResources(kind, listOf(id)).map { it to null }
        val inherited = grants.findByResources(ResourceKind.FOLDER, above).map { it to it.resourceId }
        return own + inherited
    }

    private suspend fun ancestorIds(folderId: Uuid?): List<Uuid> = ancestors(folderId).map { it.id }

    private suspend fun userRole(caller: Caller.User, self: Pair<ResourceKind, Uuid>, above: List<Uuid>): BoardRole? {
        val applying = grants.findByResources(self.first, listOf(self.second)) + grants.findByResources(FOLDER, above)
        val mine = applying.filter { matches(it, caller) }
        // A role remembered through a link lasts as long as the link works (revoked or expired: gone).
        val linkIds = mine.filter { it.principalKind == PrincipalKind.LINK_USER }.mapNotNull { it.linkId }.toSet()
        val working = if (linkIds.isEmpty()) emptySet() else {
            val now = clock.now()
            links.findAllById(linkIds).filter { it.usable(now) }.map { it.id }.toSet()
        }
        return mine.filter { it.principalKind != PrincipalKind.LINK_USER || it.linkId in working }.minOfOrNull { it.role }
    }

    private fun matches(grant: Grant, caller: Caller.User): Boolean = when (grant.principalKind) {
        PrincipalKind.USER, PrincipalKind.LINK_USER -> grant.principal == caller.id.toString()
        PrincipalKind.GROUP -> grant.principal in caller.groups
    }

    private fun guestRole(guest: Caller.Guest, id: Uuid, kind: ResourceKind, above: List<Uuid>): BoardRole? {
        val reaches = when (guest.kind) {
            ResourceKind.BOARD -> kind == ResourceKind.BOARD && guest.resourceId == id
            ResourceKind.FOLDER -> guest.resourceId in above || (kind == ResourceKind.FOLDER && guest.resourceId == id)
        }
        return guest.role.takeIf { reaches && it != BoardRole.OWNER }
    }

    companion object {
        const val MAX_DEPTH = 64
        private val BOARD = ResourceKind.BOARD
        private val FOLDER = ResourceKind.FOLDER
    }
}
