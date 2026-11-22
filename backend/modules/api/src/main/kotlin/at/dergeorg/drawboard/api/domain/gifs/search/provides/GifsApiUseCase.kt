package at.dergeorg.drawboard.api.domain.gifs.search.provides

import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch

/** The gifs part of the API in contract types. */
interface GifsApiUseCase {

    /** One page of GIFs for a search text; signed-in users only, never guests (G5). */
    suspend fun searchGifs(request: GifSearch): GifPage

    /** The first 24 trending GIFs; the same rules as [searchGifs]. */
    suspend fun listTrendingGifs(): GifPage
}
