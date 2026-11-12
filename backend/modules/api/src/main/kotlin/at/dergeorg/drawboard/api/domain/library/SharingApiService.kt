package at.dergeorg.drawboard.api.domain.library

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.api.common.GuestNames
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.common.toApi
import at.dergeorg.drawboard.api.domain.library.sharing.provides.SharingApiUseCase
import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.ShareRefresh
import at.dergeorg.drawboard.contract.model.Member
import at.dergeorg.drawboard.contract.model.MemberList
import at.dergeorg.drawboard.contract.model.MemberPrincipal
import at.dergeorg.drawboard.contract.model.MemberPrincipalKind
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.contract.model.ShareLinkList
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.ShareResourceKind
import at.dergeorg.drawboard.contract.model.SharedWithMe
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeFailure
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeOutcome
import at.dergeorg.drawboard.library.domain.sharing.model.MemberEntry
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import at.dergeorg.drawboard.library.domain.sharing.provides.CreateLinkCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.ExchangeCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.MembersUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.SetMemberCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.context.ClientAddressProvider
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.security.GuestTokenIssuer
import at.dergeorg.drawboard.shared.security.GuestTokenRequest
import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.time.Clock
import kotlin.time.Duration.Companion.hours
import kotlin.time.Instant
import kotlin.uuid.Uuid
import kotlinx.coroutines.CancellationException
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.library.domain.sharing.model.SharedView
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience as LibraryAudience
import at.dergeorg.drawboard.contract.model.ShareLink as ContractShareLink

/**
 * Implements the sharing API use cases: contract types in, library use cases, contract types out. The library knows
 * grants by user id and group name only - this service adds the display names from the users module, checks that a
 * user exists, and tells collab AFTER the library committed that access changed (open sessions are re-evaluated, S2.3).
 * No email address appears anywhere in the sharing API (S6.9).
 */
@Service
@Suppress("LongParameterList") // a Spring constructor: every port the sharing use cases connect is injected
internal class SharingApiService(
    private val signedIn: SignedInUsers,
    private val members: MembersUseCase,
    private val links: LinksUseCase,
    private val callers: Callers,
    private val guestTokens: GuestTokenIssuer,
    private val clock: Clock,
    private val clientAddress: ClientAddressProvider,
    private val properties: DrawboardProperties,
    private val profiles: UserProfilesUseCase,
    private val collab: CollabUseCase,
    private val planning: PlanningUseCase,
    private val log: AppLogger,
) : SharingApiUseCase {

    @WithSpan
    override suspend fun listMembers(kind: ShareResourceKind, @SpanAttribute("resource.id") resourceId: Uuid): MemberList {
        val view = members.listMembers(signedIn.caller(), kind.toLibrary(), resourceId)
        val users = profiles.findAllById(
            view.members.filter { it.grant.principalKind != PrincipalKind.GROUP }.map { Uuid.parse(it.grant.principal) } + view.ownerId,
        ).associateBy { it.id }
        return MemberList(
            owner = userPrincipal(view.ownerId, users[view.ownerId], MemberPrincipalKind.USER),
            items = view.members.map { it.toApi(users) },
        )
    }

    @WithSpan
    override suspend fun setUserMember(
        kind: ShareResourceKind,
        @SpanAttribute("resource.id") resourceId: Uuid,
        userId: Uuid,
        role: GrantRole,
    ): Member {
        val profile = profiles.findById(userId)
            ?: throw DomainException(ErrorCode.LIBRARY_USER_NOT_FOUND, mapOf("userId" to userId.toString()))
        members.setUserMember(SetMemberCommand(signedIn.caller(), kind.toLibrary(), resourceId, userId.toString(), role.toLibrary()))
        collab.recheckAll()
        return Member(userPrincipal(userId, profile, MemberPrincipalKind.USER), role)
    }

    @WithSpan
    override suspend fun setGroupMember(
        kind: ShareResourceKind,
        @SpanAttribute("resource.id") resourceId: Uuid,
        group: String,
        role: GrantRole,
    ): Member {
        members.setGroupMember(SetMemberCommand(signedIn.caller(), kind.toLibrary(), resourceId, group, role.toLibrary()))
        collab.recheckAll()
        return Member(groupPrincipal(group), role)
    }

    @WithSpan
    override suspend fun removeUserMember(kind: ShareResourceKind, @SpanAttribute("resource.id") resourceId: Uuid, userId: Uuid) {
        members.removeUserMember(signedIn.caller(), kind.toLibrary(), resourceId, userId)
        collab.recheckAll()
    }

    @WithSpan
    override suspend fun removeGroupMember(kind: ShareResourceKind, @SpanAttribute("resource.id") resourceId: Uuid, group: String) {
        members.removeGroupMember(signedIn.caller(), kind.toLibrary(), resourceId, group)
        collab.recheckAll()
    }

    @WithSpan
    override suspend fun listSharedWithMe(): SharedWithMe {
        val shared: SharedView = members.listSharedWithMe(signedIn.caller())
        return SharedWithMe(boards = shared.boards.map { it.toApi() }, folders = shared.folders.map { it.toApi() })
    }

    // --------------------------------------------------------------------------------------------- share links

    @WithSpan
    override suspend fun listLinks(kind: ShareResourceKind, @SpanAttribute("resource.id") resourceId: Uuid): ShareLinkList =
        ShareLinkList(items = links.listLinks(signedIn.caller(), kind.toLibrary(), resourceId).map { it.toApi() })

    @WithSpan
    override suspend fun createLink(
        kind: ShareResourceKind,
        @SpanAttribute("resource.id") resourceId: Uuid,
        newShareLink: NewShareLink,
    ): CreatedShareLink {
        // A link for guests on an instance that does not allow guests would be a promise it cannot keep (S1.14).
        if (newShareLink.audience == ShareAudience.GUESTS && !properties.guestsEnabled) throw DomainException(ErrorCode.FORBIDDEN)
        val created = links.createLink(
            CreateLinkCommand(
                caller = signedIn.caller(),
                kind = kind.toLibrary(),
                resourceId = resourceId,
                role = newShareLink.role.toLibrary(),
                audience = newShareLink.audience.toLibrary(),
                expiresAt = newShareLink.expiresAt,
                password = newShareLink.password,
            ),
        )
        // The token lives in the fragment (S1.2): it never reaches a server log or a Referer.
        return CreatedShareLink(link = created.link.toApi(), url = "${properties.origin}/s#${created.token}")
    }

    @WithSpan
    override suspend fun revokeLink(@SpanAttribute("share.id") linkId: Uuid) {
        links.revokeLink(signedIn.caller(), linkId)
        // Remembered access and guest sessions of this link end now (S1.13): sessions are re-evaluated.
        collab.recheckAll()
        // Its guests leave the open planning poker rounds with their votes (M4 review); the library does not know the planning module.
        // The revoke is committed and the sessions are cut: if this fails the link is still revoked and the answer stays 204. The guests
        // that stay are dropped at the reveal (LibraryGuestShares); the error is logged with the share id so somebody can look.
        try {
            planning.removeGuestsOfShare(linkId)
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            log.error("the guests of a revoked link could not be removed from the planning rounds", e, "share.id" to linkId.toString())
        }
    }

    @WithSpan
    override suspend fun exchange(request: ShareExchange): ShareAccess {
        val caller = signedIn.callerOrNull()
        val guestName = if (caller == null) guestNameOf(request.guestName) else null
        val outcome = links.exchange(
            ExchangeCommand(
                token = request.token,
                password = request.password,
                caller = caller,
                ip = clientAddress.clientAddress(),
                guestsEnabled = properties.guestsEnabled,
                guestName = guestName,
            ),
        )
        return when (outcome) {
            is ExchangeOutcome.SignedIn -> ShareAccess(kind = outcome.kind.toApi(), id = outcome.resourceId, role = outcome.role.toApi())
            is ExchangeOutcome.Guest -> {
                val session = guestSession(outcome, Uuid.generateV7(), checkNotNull(guestName), clock.now(), outcome.passwordVerified)
                ShareAccess(kind = outcome.kind.toApi(), id = outcome.resourceId, role = outcome.role.toApi(), guestSession = session)
            }
            is ExchangeOutcome.Failed -> throw outcome.toException()
        }
    }

    @WithSpan
    override suspend fun refresh(request: ShareRefresh): GuestSession {
        val guest = callers.guestOrNull() ?: throw DomainException(ErrorCode.FORBIDDEN)
        // The hard limit (S1.4): 12 hours after the first exchange nothing renews the session.
        if (clock.now() >= guest.authTime + guestTokens.sessionLimitHours.hours) throw DomainException(ErrorCode.UNAUTHORIZED)
        val outcome = links.checkRefresh(guest.shareId, request.token, clientAddress.clientAddress())
        return when (outcome) {
            // revocation, expiry and the role are re-read from the link, everything else stays as the session began
            is ExchangeOutcome.Guest -> guestSession(outcome, guest.id, guest.name, guest.authTime, guest.passwordVerified)
            is ExchangeOutcome.Failed -> throw outcome.toException()
            is ExchangeOutcome.SignedIn -> error("a refresh never yields a signed-in outcome")
        }
    }

    private fun guestSession(outcome: ExchangeOutcome.Guest, guestId: Uuid, name: String, authTime: Instant, pw: Boolean): GuestSession {
        val issued = guestTokens.issue(
            GuestTokenRequest(
                guestId = guestId,
                shareId = outcome.shareId,
                kind = outcome.kind.name,
                resourceId = outcome.resourceId,
                role = outcome.role.name,
                name = name,
                passwordVerified = pw,
                authTime = authTime,
                shareExpiresAt = outcome.shareExpiresAt,
            ),
        )
        return GuestSession(
            accessToken = issued.token,
            expiresAt = issued.expiresAt,
            kind = outcome.kind.toApi(),
            id = outcome.resourceId,
            role = outcome.role.toGrantRole(),
            name = name,
        )
    }

    /** The name a guest goes by: sanitised, and never the name of a registered user (S1.10). */
    private suspend fun guestNameOf(raw: String?): String? {
        val name = GuestNames.sanitize(raw) ?: return null
        return if (profiles.nameTaken(name)) GuestNames.asGuest(name) else name
    }

    private fun ExchangeOutcome.Failed.toException(): DomainException = when (reason) {
        ExchangeFailure.NOT_FOUND -> DomainException(ErrorCode.LIBRARY_SHARE_NOT_FOUND)
        ExchangeFailure.LOGIN_REQUIRED -> DomainException(ErrorCode.LIBRARY_SHARE_LOGIN_REQUIRED)
        ExchangeFailure.PASSWORD_REQUIRED -> DomainException(ErrorCode.LIBRARY_SHARE_PASSWORD_REQUIRED)
        ExchangeFailure.PASSWORD_INVALID -> DomainException(ErrorCode.LIBRARY_SHARE_PASSWORD_INVALID)
        ExchangeFailure.RATE_LIMITED -> RateLimitedException(retryAfterSeconds.coerceAtLeast(1))
        ExchangeFailure.NAME_REQUIRED ->
            ValidationFailedException(listOf(InvalidField("guestName", "NotBlank", "a guest needs a display name")))
    }

    private fun ShareLink.toApi() = ContractShareLink(
        id = id,
        role = role.toGrantRole(),
        audience = audience.toApi(),
        passwordProtected = passwordProtected,
        createdAt = createdAt,
        useCount = useCount,
        expiresAt = expiresAt,
        revokedAt = revokedAt,
    )

    private fun ShareAudience.toLibrary() = when (this) {
        ShareAudience.SIGNED_IN -> LibraryAudience.SIGNED_IN
        ShareAudience.GUESTS -> LibraryAudience.GUESTS
    }

    private fun LibraryAudience.toApi() = when (this) {
        LibraryAudience.SIGNED_IN -> ShareAudience.SIGNED_IN
        LibraryAudience.GUESTS -> ShareAudience.GUESTS
    }

    private fun ResourceKind.toApi() = when (this) {
        ResourceKind.BOARD -> ShareResourceKind.BOARD
        ResourceKind.FOLDER -> ShareResourceKind.FOLDER
    }

    private fun MemberEntry.toApi(users: Map<Uuid, UserProfile>): Member {
        val principal = when (grant.principalKind) {
            PrincipalKind.GROUP -> groupPrincipal(grant.principal)
            PrincipalKind.USER -> userPrincipal(grant.userId(), users[grant.userId()], MemberPrincipalKind.USER)
            PrincipalKind.LINK_USER -> userPrincipal(grant.userId(), users[grant.userId()], MemberPrincipalKind.LINK_USER)
        }
        return Member(principal = principal, role = grant.toGrantRole(), inheritedFrom = inheritedFrom)
    }

    private fun userPrincipal(id: Uuid, profile: UserProfile?, kind: MemberPrincipalKind) = MemberPrincipal(
        kind = kind,
        displayName = profile?.let { it.displayName ?: it.username } ?: UNKNOWN_USER,
        userId = id,
        username = profile?.username,
    )

    private fun groupPrincipal(group: String) = MemberPrincipal(kind = MemberPrincipalKind.GROUP, displayName = group, group = group)

    private fun Grant.toGrantRole() = role.toGrantRole()

    private fun Grant.userId(): Uuid = Uuid.parse(principal)

    private fun ShareResourceKind.toLibrary() = when (this) {
        ShareResourceKind.BOARD -> ResourceKind.BOARD
        ShareResourceKind.FOLDER -> ResourceKind.FOLDER
    }

    private fun GrantRole.toLibrary() = when (this) {
        GrantRole.EDITOR -> BoardRole.EDITOR
        GrantRole.COMMENTER -> BoardRole.COMMENTER
        GrantRole.VIEWER -> BoardRole.VIEWER
    }

    private fun BoardRole.toGrantRole() = when (this) {
        BoardRole.EDITOR -> GrantRole.EDITOR
        BoardRole.COMMENTER -> GrantRole.COMMENTER
        BoardRole.VIEWER, BoardRole.OWNER -> GrantRole.VIEWER
    }

    private companion object {
        const val UNKNOWN_USER = "Unknown user"
    }
}
