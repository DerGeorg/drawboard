package at.dergeorg.drawboard.api.domain.gifs

import at.dergeorg.drawboard.api.common.Callers
import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.domain.gifs.search.provides.GifsApiUseCase
import at.dergeorg.drawboard.contract.model.Gif
import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.gifs.domain.search.model.GifResults
import at.dergeorg.drawboard.gifs.domain.search.model.SearchGifsCommand
import at.dergeorg.drawboard.gifs.domain.search.provides.GifSearchUseCase
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.uuid.Uuid

/**
 * Implements the API use cases of the gifs module (3.14, G3, G5, G7): the order is "GIFs are off here" (404 for every signed-in
 * caller, the same answer), then who calls (a guest is 403 even with an EDITOR link, S1.8 unchanged), then everything the module
 * itself checks (the text, the limits, the cache, the budget). The route table already turns guests away; this is the second lock.
 * The search text is never an attribute of a span and never a log field.
 */
@Service
internal class GifsApiService(
    private val gifs: GifSearchUseCase,
    private val signedIn: SignedInUsers,
    private val callers: Callers,
) : GifsApiUseCase {

    @WithSpan
    override suspend fun searchGifs(request: GifSearch): GifPage {
        gifs.requireEnabled()
        val user = userId()
        return gifs.search(SearchGifsCommand(user, request.q, request.page ?: 0, request.lang)).toContract()
    }

    @WithSpan
    override suspend fun listTrendingGifs(): GifPage {
        gifs.requireEnabled()
        return gifs.trending(userId()).toContract()
    }

    /** The user's own id; a guest is no caller of this API. */
    private suspend fun userId(): Uuid {
        if (callers.guestOrNull() != null) throw DomainException(ErrorCode.FORBIDDEN)
        return signedIn.caller().id
    }

    private fun GifResults.toContract() = GifPage(items = items.map { Gif(it.id, it.title, it.width, it.height) }, hasMore = hasMore)
}
