package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import at.dergeorg.drawboard.planning.domain.rounds.requires.GuestShares
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Component
import kotlin.uuid.Uuid

/**
 * The port planning requires, implemented on top of library: planning and library never know each other, api is where they are
 * connected. A link is gone when `library` no longer knows a guest for it (revoked, expired, or its resource deleted - S1.13).
 */
@Component
internal class LibraryGuestShares(private val links: LinksUseCase) : GuestShares {

    @WithSpan
    override suspend fun revoked(shareIds: Collection<Uuid>): Set<Uuid> = shareIds.filter { links.guestCaller(it) == null }.toSet()
}
