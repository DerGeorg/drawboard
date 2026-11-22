package at.dergeorg.drawboard.gifs.domain.search.provides

import at.dergeorg.drawboard.gifs.domain.search.model.GifResults
import at.dergeorg.drawboard.gifs.domain.search.model.SearchGifsCommand
import kotlin.uuid.Uuid

/**
 * GIF search at GIPHY through the server (3.14, decisions G1-G16). Like files and planning the module trusts its caller (module
 * `api`) with everything that needs a token: that the caller is a signed-in user and no guest (G5), and who it is.
 *
 * The order of the checks is fixed (G7): disabled, then validation, then the limits of the user (counted for a cache hit too),
 * then the cache, then the budget of the instance (counted for a call to GIPHY only), then GIPHY.
 */
interface GifSearchUseCase {

    /** Whether this instance has a GIPHY key (G3): `CurrentUser.gifsEnabled`. */
    fun isEnabled(): Boolean

    /** Throws `GIFS_DISABLED` (404) when there is no key. The first check of every operation, the same answer for every caller. */
    fun requireEnabled()

    /**
     * One page of [SearchGifsCommand.q]. `VALIDATION_FAILED` (400) when the text has fewer than 2 characters after trimming and
     * collapsing; `TOO_MANY_REQUESTS` (429) over 10 per minute or 40 per hour of the user; `GIFS_BUDGET_EXHAUSTED` (429) when the
     * hourly budget of the instance is used up or GIPHY itself says 429; `GIFS_UNAVAILABLE` (503) when GIPHY fails or refuses the key.
     */
    suspend fun search(command: SearchGifsCommand): GifResults

    /** The first 24 trending GIFs (no paging, `hasMore` false), cached for 30 minutes. The same limits and errors as [search]. */
    suspend fun trending(userId: Uuid): GifResults
}
