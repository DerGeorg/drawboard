package at.dergeorg.drawboard.integration.gifs

import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GifSearch
import at.dergeorg.drawboard.integration.IntegrationTest
import at.dergeorg.drawboard.integration.signedInAs
import at.dergeorg.drawboard.shared.testing.TestUsers.ALICE
import at.dergeorg.drawboard.shared.testing.TestUsers.BOB
import at.dergeorg.drawboard.shared.testing.TestUsers.CAROL
import io.micrometer.core.instrument.MeterRegistry
import org.junit.jupiter.api.Test
import org.springframework.http.HttpStatus
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals

/** An instance without a GIPHY key (the default of every other integration test): GIF search does not exist (G1, G3, G7). */
@IntegrationTest
class GifsDisabledIntegrationTest(private val client: WebTestClient, private val meters: MeterRegistry) {

    private fun disabled() = meters.find("drawboard.gifs.requests").tag("outcome", "disabled").counter()?.count() ?: 0.0

    @Test
    fun `when GET users me given no key then gifsEnabled is false`() {
        val me = client.signedInAs(BOB).get().uri("/api/users/me").exchange().expectBody<CurrentUser>().returnResult().responseBody

        assertEquals(false, me?.gifsEnabled, "G3: no key, no GIF search")
    }

    @Test
    fun `when a signed-in user searches or lists trending given no key then 404 GIFS_DISABLED, the same for every user`() {
        val before = disabled()

        val answers = listOf(ALICE, BOB, CAROL).flatMap { user ->
            listOf(
                client.signedInAs(user).post().uri("/api/gifs/search").bodyValue(GifSearch("cat")).exchange()
                    .expectBody<ErrorModel>().returnResult(),
                client.signedInAs(user).get().uri("/api/gifs/trending").exchange().expectBody<ErrorModel>().returnResult(),
            )
        }

        answers.forEach { assertEquals(HttpStatus.NOT_FOUND, it.status, "status") }
        assertEquals(setOf(ErrorCode.GIFS_DISABLED), answers.map { it.responseBody?.code }.toSet(), "error code")
        assertEquals(1, answers.map { it.responseBody?.detail }.toSet().size, "one text for everybody: nothing says who asked")
        assertEquals(6.0, disabled() - before, "counted as disabled")
    }

    @Test
    fun `when a user sends invalid input or sends often given no key then still 404 - disabled is the first check`() {
        val http = client.signedInAs(BOB)

        val answers = (1..15).map {
            http.post().uri("/api/gifs/search").bodyValue(GifSearch("a")).exchange().expectBody<ErrorModel>().returnResult()
        }

        assertEquals(setOf(ErrorCode.GIFS_DISABLED), answers.map { it.responseBody?.code }.toSet(),
            "no 400 for a short text, no 429 for the 11th (G7)")
    }

    @Test
    fun `when nobody is signed in then 401, not 404 - an anonymous caller learns nothing about the instance`() {
        val result = client.post().uri("/api/gifs/search").bodyValue(GifSearch("cat")).exchange().expectBody<ErrorModel>().returnResult()

        assertEquals(HttpStatus.UNAUTHORIZED, result.status, "status")
    }
}
