package at.dergeorg.drawboard.api.domain.library.sharing.provides.impl

import at.dergeorg.drawboard.api.domain.library.sharing.provides.SharingApiUseCase
import at.dergeorg.drawboard.contract.api.SharingApi
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.Member
import at.dergeorg.drawboard.contract.model.MemberList
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.ShareLinkList
import at.dergeorg.drawboard.contract.model.ShareRefresh
import at.dergeorg.drawboard.contract.model.ShareResourceKind
import at.dergeorg.drawboard.contract.model.SharedWithMe
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController
import kotlin.uuid.Uuid

/**
 * HTTP only: implements the generated [SharingApi] and delegates to [SharingApiUseCase].
 */
@RestController
@Suppress("TooManyFunctions")
internal class SharingController(private val sharing: SharingApiUseCase) : SharingApi {

    private val board = ShareResourceKind.BOARD
    private val folder = ShareResourceKind.FOLDER

    // --- members ---

    @WithSpan
    override suspend fun listBoardMembers(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<MemberList> =
        ResponseEntity.ok(sharing.listMembers(board, boardId))

    @WithSpan
    override suspend fun listFolderMembers(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<MemberList> =
        ResponseEntity.ok(sharing.listMembers(folder, folderId))

    @WithSpan
    override suspend fun setBoardUserMember(
        @SpanAttribute("board.id") boardId: Uuid,
        userId: Uuid,
        memberUpdate: MemberUpdate,
    ): ResponseEntity<Member> = ResponseEntity.ok(sharing.setUserMember(board, boardId, userId, memberUpdate.role))

    @WithSpan
    override suspend fun setFolderUserMember(
        @SpanAttribute("folder.id") folderId: Uuid,
        userId: Uuid,
        memberUpdate: MemberUpdate,
    ): ResponseEntity<Member> = ResponseEntity.ok(sharing.setUserMember(folder, folderId, userId, memberUpdate.role))

    @WithSpan
    override suspend fun setBoardGroupMember(
        @SpanAttribute("board.id") boardId: Uuid,
        group: String,
        memberUpdate: MemberUpdate,
    ): ResponseEntity<Member> = ResponseEntity.ok(sharing.setGroupMember(board, boardId, group, memberUpdate.role))

    @WithSpan
    override suspend fun setFolderGroupMember(
        @SpanAttribute("folder.id") folderId: Uuid,
        group: String,
        memberUpdate: MemberUpdate,
    ): ResponseEntity<Member> = ResponseEntity.ok(sharing.setGroupMember(folder, folderId, group, memberUpdate.role))

    @WithSpan
    override suspend fun removeBoardUserMember(@SpanAttribute("board.id") boardId: Uuid, userId: Uuid): ResponseEntity<Unit> {
        sharing.removeUserMember(board, boardId, userId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun removeFolderUserMember(@SpanAttribute("folder.id") folderId: Uuid, userId: Uuid): ResponseEntity<Unit> {
        sharing.removeUserMember(folder, folderId, userId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun removeBoardGroupMember(@SpanAttribute("board.id") boardId: Uuid, group: String): ResponseEntity<Unit> {
        sharing.removeGroupMember(board, boardId, group)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun removeFolderGroupMember(@SpanAttribute("folder.id") folderId: Uuid, group: String): ResponseEntity<Unit> {
        sharing.removeGroupMember(folder, folderId, group)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun listSharedWithMe(): ResponseEntity<SharedWithMe> = ResponseEntity.ok(sharing.listSharedWithMe())

    // --- links ---

    @WithSpan
    override suspend fun createBoardShareLink(
        @SpanAttribute("board.id") boardId: Uuid,
        newShareLink: NewShareLink,
    ): ResponseEntity<CreatedShareLink> = ResponseEntity.status(HttpStatus.CREATED).body(sharing.createLink(board, boardId, newShareLink))

    @WithSpan
    override suspend fun createFolderShareLink(
        @SpanAttribute("folder.id") folderId: Uuid,
        newShareLink: NewShareLink,
    ): ResponseEntity<CreatedShareLink> = ResponseEntity.status(HttpStatus.CREATED).body(sharing.createLink(folder, folderId, newShareLink))

    @WithSpan
    override suspend fun listBoardShareLinks(@SpanAttribute("board.id") boardId: Uuid): ResponseEntity<ShareLinkList> =
        ResponseEntity.ok(sharing.listLinks(board, boardId))

    @WithSpan
    override suspend fun listFolderShareLinks(@SpanAttribute("folder.id") folderId: Uuid): ResponseEntity<ShareLinkList> =
        ResponseEntity.ok(sharing.listLinks(folder, folderId))

    @WithSpan
    override suspend fun revokeShareLink(@SpanAttribute("share.id") linkId: Uuid): ResponseEntity<Unit> {
        sharing.revokeLink(linkId)
        return ResponseEntity.noContent().build()
    }

    @WithSpan
    override suspend fun exchangeShareToken(shareExchange: ShareExchange): ResponseEntity<ShareAccess> =
        ResponseEntity.ok(sharing.exchange(shareExchange))

    @WithSpan
    override suspend fun refreshGuestSession(shareRefresh: ShareRefresh): ResponseEntity<GuestSession> =
        ResponseEntity.ok(sharing.refresh(shareRefresh))
}
