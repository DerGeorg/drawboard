package at.dergeorg.drawboard.api.domain.gifs

import at.dergeorg.drawboard.api.domain.gifs.search.provides.GifsApiUseCase
import at.dergeorg.drawboard.api.domain.gifs.search.provides.impl.GifsController
import at.dergeorg.drawboard.api.infra.web.WebSliceTestConfiguration
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.Gif
import at.dergeorg.drawboard.contract.model.GifPage
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.error.RetryAfterException
import com.ninjasquad.springmockk.MockkBean
import io.mockk.coEvery
import io.mockk.coVerify
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.webflux.test.autoconfigure.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import at.dergeorg.drawboard.shared.error.ErrorCode as DomainErrorCode

/** Slice test: GifsController + WebFlux + error rendering; the API use case is a mock. Authentication: RouteTableIntegrationTest. */
@WebFluxTest(GifsController::class)
@Import(WebSliceTestConfiguration::class)
class GifsControllerTest(private val client: WebTestClient) {

    @MockkBean
    private lateinit var gifs: GifsApiUseCase

    private val page = GifPage(items = listOf(Gif("abc123", "A cat", 480, 270)), hasMore = true)

    @Nested
    inner class Search {

        @Test
        fun `when POST gifs search given a text then 200 with the page and Cache-Control no-store`() {
            coEvery { gifs.searchGifs(GifSearch(q = "cat", page = 1, lang = "en")) } returns page

            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch(q = "cat", page = 1, lang = "en")).exchange()
                .expectBody<GifPage>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of POST /api/gifs/search")
            assertEquals(page, result.responseBody, "the page in the body")
            assertEquals("no-store", result.responseHeaders.getFirst(HttpHeaders.CACHE_CONTROL),
                "what a user searched must not be cached (G8)")
        }

        @Test
        fun `when POST gifs search given a text of one character then the contract answers 400 and the use case is not called`() {
            val result = client.post().uri("/api/gifs/search").bodyValue(mapOf("q" to "")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.BAD_REQUEST, result.status, "an empty text")
            assertEquals(ErrorCode.VALIDATION_FAILED, result.responseBody?.code, "error code")
            coVerify(exactly = 0) { gifs.searchGifs(any()) }
        }

        @Test
        fun `when POST gifs search given a control character or a page above 9 then 400 VALIDATION_FAILED without echoing the text`() {
            val control = client.post().uri("/api/gifs/search").bodyValue(mapOf("q" to "cat\u0007")).exchange()
                .expectBody<String>().returnResult()
            val page10 = client.post().uri("/api/gifs/search").bodyValue(mapOf("q" to "cat", "page" to 10)).exchange()
                .expectBody<String>().returnResult()

            assertEquals(listOf(HttpStatus.BAD_REQUEST, HttpStatus.BAD_REQUEST), listOf(control.status, page10.status), "contract limits")
            assertEquals(false, control.responseBody.orEmpty().contains("cat"), "the text is not in the answer")
        }

        @Test
        fun `when POST gifs search given a user over the limit then 429 TOO_MANY_REQUESTS with Retry-After`() {
            coEvery { gifs.searchGifs(any()) } throws RateLimitedException(17)

            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch(q = "cat")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, result.status, "status")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, result.responseBody?.code, "error code")
            assertEquals("17", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }

        @Test
        fun `when POST gifs search given the budget is used up then 429 GIFS_BUDGET_EXHAUSTED with Retry-After`() {
            coEvery { gifs.searchGifs(any()) } throws RetryAfterException(DomainErrorCode.GIFS_BUDGET_EXHAUSTED, 120)

            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch(q = "cat")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, result.status, "status")
            assertEquals(ErrorCode.GIFS_BUDGET_EXHAUSTED, result.responseBody?.code, "error code")
            assertEquals("120", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }

        @Test
        fun `when POST gifs search given GIPHY is down then 503 GIFS_UNAVAILABLE with Retry-After`() {
            coEvery { gifs.searchGifs(any()) } throws RetryAfterException(DomainErrorCode.GIFS_UNAVAILABLE, 30)

            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch(q = "cat")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, result.status, "status")
            assertEquals(ErrorCode.GIFS_UNAVAILABLE, result.responseBody?.code, "error code")
            assertEquals("30", result.responseHeaders.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }

        @Test
        fun `when POST gifs search given the instance has no key then 404 GIFS_DISABLED`() {
            coEvery { gifs.searchGifs(any()) } throws DomainException(DomainErrorCode.GIFS_DISABLED)

            val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch(q = "cat")).exchange()
                .expectBody<ErrorModel>().returnResult()

            assertEquals(HttpStatus.NOT_FOUND, result.status, "status")
            assertEquals(ErrorCode.GIFS_DISABLED, result.responseBody?.code, "error code")
        }
    }

    @Nested
    inner class Trending {

        @Test
        fun `when GET gifs trending then 200 with the page and Cache-Control no-store`() {
            coEvery { gifs.listTrendingGifs() } returns page

            val result = client.get().uri("/api/gifs/trending").exchange().expectBody<GifPage>().returnResult()

            assertEquals(HttpStatus.OK, result.status, "status of GET /api/gifs/trending")
            assertEquals(page, result.responseBody, "the page in the body")
            assertEquals("no-store", result.responseHeaders.getFirst(HttpHeaders.CACHE_CONTROL), "Cache-Control")
        }
    }
}
