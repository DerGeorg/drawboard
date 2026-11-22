package at.dergeorg.drawboard.api.domain.gifs.search.provides.impl

import at.dergeorg.drawboard.api.domain.gifs.search.provides.GifsApiUseCase
import at.dergeorg.drawboard.contract.api.GifsApi
import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RestController

/**
 * HTTP only: implements the generated [GifsApi] and delegates to [GifsApiUseCase]. Both answers carry `Cache-Control: no-store`
 * (G8): what a user searched for must not stay in a browser or proxy cache. The route table in core keeps guests out.
 */
@RestController
internal class GifsController(private val gifs: GifsApiUseCase) : GifsApi {

    @WithSpan
    override suspend fun searchGifs(gifSearch: GifSearch): ResponseEntity<GifPage> = noStore(gifs.searchGifs(gifSearch))

    @WithSpan
    override suspend fun listTrendingGifs(): ResponseEntity<GifPage> = noStore(gifs.listTrendingGifs())

    private fun noStore(page: GifPage): ResponseEntity<GifPage> = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(page)
}
