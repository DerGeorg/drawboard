package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.CreatedShareLink
import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.ErrorModel
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.GuestSession
import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.NewShareLink
import at.dergeorg.drawboard.contract.model.PokerDeck
import at.dergeorg.drawboard.contract.model.PokerDeckKind
import at.dergeorg.drawboard.contract.model.PokerRound
import at.dergeorg.drawboard.contract.model.PokerRoundList
import at.dergeorg.drawboard.contract.model.PokerVote
import at.dergeorg.drawboard.contract.model.ShareAccess
import at.dergeorg.drawboard.contract.model.ShareAudience
import at.dergeorg.drawboard.contract.model.ShareExchange
import at.dergeorg.drawboard.integration.collab.SharingUser
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import tools.jackson.databind.json.JsonMapper
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.uuid.Uuid

/** What an HTTP call answered, with the body as text so a test can parse it as it needs (or look for a secret in it). */
class Reply(val status: HttpStatus, val headers: HttpHeaders, val body: String, private val json: JsonMapper) {
    fun round(): PokerRound = json.readValue(body, PokerRound::class.java)

    fun rounds(): PokerRoundList = json.readValue(body, PokerRoundList::class.java)

    fun error(): ErrorModel = json.readValue(body, ErrorModel::class.java)

    val etag: String? get() = headers.getFirst(HttpHeaders.ETAG)
}

/** A caller of the planning API: a signed-in user or a guest - both are just a client with an `Authorization` header. */
class Actor(val http: WebTestClient, private val json: JsonMapper) {

    fun call(method: HttpMethod, uri: String, body: Any? = null, headers: Map<String, String> = emptyMap()): Reply {
        val spec = http.method(method).uri(uri).headers { h -> headers.forEach { (name, value) -> h.add(name, value) } }
        val result = (if (body != null) spec.contentType(MediaType.APPLICATION_JSON).bodyValue(body) else spec).exchange()
            .expectBody<String>().returnResult()
        return Reply(HttpStatus.valueOf(result.status.value()), result.responseHeaders, result.responseBody.orEmpty(), json)
    }

    /** Starts a round on a new story card by default; `storyBlockId = null` starts a quick round without a card. */
    fun create(boardId: Uuid, storyBlockId: String? = Uuid.random().toString(), title: String = "Story", deck: PokerDeck = FIBONACCI) =
        call(HttpMethod.POST, "/api/boards/$boardId/poker-rounds", NewPokerRound(title = title, deck = deck, storyBlockId = storyBlockId))

    /** Creates a round and expects 201; returns it. */
    fun start(boardId: Uuid, storyBlockId: String? = Uuid.random().toString(), deck: PokerDeck = FIBONACCI): PokerRound {
        val reply = create(boardId, storyBlockId, deck = deck)
        assertEquals(HttpStatus.CREATED, reply.status, "starting a round, body ${reply.body}")
        return reply.round()
    }

    fun list(boardId: Uuid, state: String? = null) =
        call(HttpMethod.GET, "/api/boards/$boardId/poker-rounds" + (state?.let { "?state=$it" } ?: ""))

    fun get(boardId: Uuid, roundId: Uuid, ifNoneMatch: String? = null) = call(
        HttpMethod.GET, "/api/boards/$boardId/poker-rounds/$roundId",
        headers = ifNoneMatch?.let { mapOf(HttpHeaders.IF_NONE_MATCH to it) }.orEmpty(),
    )

    fun vote(boardId: Uuid, roundId: Uuid, value: String) =
        call(HttpMethod.PUT, "/api/boards/$boardId/poker-rounds/$roundId/vote", PokerVote(value))

    fun reveal(boardId: Uuid, roundId: Uuid) = call(HttpMethod.POST, "/api/boards/$boardId/poker-rounds/$roundId/reveal")

    fun cancel(boardId: Uuid, roundId: Uuid) = call(HttpMethod.POST, "/api/boards/$boardId/poker-rounds/$roundId/cancel")

    companion object {
        val FIBONACCI = PokerDeck(PokerDeckKind.FIBONACCI)
    }
}

fun SharingUser.actor(json: JsonMapper) = Actor(http(), json)

fun Reply.assertCode(status: HttpStatus, code: ErrorCode, message: String) {
    assertEquals(status, this.status, "$message: status, body $body")
    assertEquals(code, error().code, "$message: error code")
}

/** A link for guests; returns the token of the URL fragment and the link's id. */
fun guestLink(owner: SharingUser, resource: String, id: Uuid, role: GrantRole): Pair<String, Uuid> {
    val created = owner.http().post().uri("/api/$resource/$id/links").bodyValue(NewShareLink(role, ShareAudience.GUESTS, null, null))
        .exchange().expectBody<CreatedShareLink>().returnResult()
    assertEquals(HttpStatus.CREATED, created.status, "creating the guest link")
    return created.responseBody!!.url.substringAfter('#') to created.responseBody!!.link.id
}

/** Opens a guest link as a visitor without an account (own address, so the per-address limits of other tests never meet). */
fun openAsGuest(client: WebTestClient, json: JsonMapper, token: String, name: String): GuestSession {
    val address = "10.${(0..255).random()}.${(0..255).random()}.${(1..254).random()}"
    val result = client.post().uri("/api/shares/exchange").header("X-Forwarded-For", address)
        .bodyValue(ShareExchange(token, null, name)).exchange().expectBody<String>().returnResult()
    assertEquals(HttpStatus.OK, result.status, "the exchange of a guest link, body ${result.responseBody}")
    return assertNotNull(json.readValue(checkNotNull(result.responseBody), ShareAccess::class.java).guestSession, "guest session")
}

fun guestActor(client: WebTestClient, json: JsonMapper, session: GuestSession) =
    Actor(client.mutate().defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer ${session.accessToken}").build(), json)
