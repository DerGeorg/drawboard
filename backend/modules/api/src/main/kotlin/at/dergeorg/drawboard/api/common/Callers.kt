package at.dergeorg.drawboard.api.common

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import at.dergeorg.drawboard.shared.context.CurrentGuest
import at.dergeorg.drawboard.shared.context.CurrentGuestProvider
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Component

/**
 * Who calls a route that guests may also call (S1.8): a signed-in user or a guest. Authorisation branches on the type
 * (S1.7). A guest is only as good as the link behind the token: it is looked up again on EVERY request (S1.13, the
 * library caches it for at most 30 seconds), and the token must still say what the link says - otherwise the token is
 * dead (401), exactly like an expired one.
 */
@Component
internal class Callers(
    private val signedIn: SignedInUsers,
    private val guests: CurrentGuestProvider,
    private val links: LinksUseCase,
) {

    /** The guest of this request's token, or null if a user (or nobody) calls. Not checked against the link. */
    @WithSpan
    suspend fun guestOrNull(): CurrentGuest? = guests.currentGuestOrNull()

    /** The caller as the library knows it: the signed-in user, or the guest the link still stands for. */
    @WithSpan
    suspend fun any(): Caller {
        val guest = guests.currentGuestOrNull() ?: return signedIn.caller()
        val current = links.guestCaller(guest.shareId) ?: throw DomainException(ErrorCode.UNAUTHORIZED)
        val sameResource = current.resourceId == guest.resourceId && current.kind.name == guest.resourceKind
        if (!sameResource || current.role == BoardRole.OWNER) throw DomainException(ErrorCode.UNAUTHORIZED)
        return current
    }

    /** [ResourceKind] of a claim value (`BOARD` / `FOLDER`). */
    fun kindOf(guest: CurrentGuest): ResourceKind = ResourceKind.valueOf(guest.resourceKind)
}
