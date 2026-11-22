package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.provides.BoardsUseCase
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import org.springframework.stereotype.Component
import kotlin.uuid.Uuid

/**
 * What every API service of the planning module needs before it calls the domain: who the caller is and what the board allows them
 * (member or guest, role, 404/403), the weak `If-None-Match` comparison and the display names of deleted users. Shared by the poker
 * rounds and the estimation sessions, so both answer a caller the same way.
 */
@Component
internal class PlanningAccess(
    private val signedIn: SignedInUsers,
    private val callers: Callers,
    private val boards: BoardsUseCase,
    private val profiles: UserProfilesUseCase,
) {

    /** Who asks and what they may be: a signed-in member with the role on the board, or a guest with the role of its link. */
    class Access(val principal: Principal, val role: BoardRole, val guest: CurrentGuest?)

    class Member(val principal: Principal.Member, val role: BoardRole)

    /**
     * The caller on [boardId] for the operations guests share with members: no role = the board does not exist for the caller (404,
     * also for a board in the trash); a guest needs a COMMENTER or EDITOR link, otherwise 403 `FORBIDDEN` (S1.8, M4 review).
     */
    suspend fun access(boardId: Uuid): Access {
        val guest = callers.guestOrNull()
        val caller = callers.any()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (guest != null) {
            if (role != BoardRole.COMMENTER && role != BoardRole.EDITOR) throw DomainException(ErrorCode.FORBIDDEN)
            return Access(Principal.Guest(guest.id, guest.name, guest.shareId), role, guest)
        }
        return Access(memberOf(), role, null)
    }

    /** Operations without a guest variant: a guest is 403 `FORBIDDEN`. */
    suspend fun denyGuest() {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
    }

    suspend fun requireMember(boardId: Uuid, required: String, allowed: (BoardRole) -> Boolean): Member {
        denyGuest()
        val caller = signedIn.caller()
        val role = boards.roleOf(caller, boardId) ?: throw boardNotFound(boardId)
        if (!allowed(role)) throw accessDenied(boardId, required)
        return Member(memberOf(), role)
    }

    suspend fun memberOf(): Principal.Member {
        val profile = signedIn.profile()
        return Principal.Member(profile.id, profile.displayName?.takeIf { it.isNotBlank() } ?: profile.username)
    }

    /**
     * Weak comparison of `If-None-Match` (RFC 9110) with the ETag `W/"<version>"`; `*` counts as no match (M4 contract), so a client
     * that has nothing cached always gets the round. The list may hold several tags.
     */
    fun matches(ifNoneMatch: String?, version: Long): Boolean =
        ifNoneMatch != null && ifNoneMatch.split(',').map { it.trim().removePrefix("W/") }.any { it == "\"$version\"" }

    suspend fun namesOf(ids: Collection<Uuid>): NameBook =
        NameBook(if (ids.isEmpty()) emptySet() else profiles.findAllById(ids.toSet()).map { it.id }.toSet())

    fun boardNotFound(boardId: Uuid) = DomainException(ErrorCode.LIBRARY_BOARD_NOT_FOUND, mapOf("boardId" to boardId.toString()))

    fun accessDenied(boardId: Uuid, required: String) =
        DomainException(ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, mapOf("boardId" to boardId.toString(), "required" to required))
}

    /** Display names as they were when the participant joined - except that a user who does not exist any more reads "Deleted user". */
    internal class NameBook(private val existing: Set<Uuid>) {
        fun name(userId: Uuid?, stored: String): String = if (userId != null && userId !in existing) DELETED_USER else stored
    }

private const val DELETED_USER = "Deleted user"
