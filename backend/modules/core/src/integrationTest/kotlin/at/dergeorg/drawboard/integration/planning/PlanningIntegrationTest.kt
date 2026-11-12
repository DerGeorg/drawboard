package at.dergeorg.drawboard.integration.planning

import at.dergeorg.drawboard.contract.model.ErrorCode
import at.dergeorg.drawboard.contract.model.GrantRole
import at.dergeorg.drawboard.contract.model.MemberUpdate
import at.dergeorg.drawboard.contract.model.NewPokerRound
import at.dergeorg.drawboard.contract.model.PokerDeck
import at.dergeorg.drawboard.contract.model.PokerDeckKind
import at.dergeorg.drawboard.contract.model.PokerRoundState
import at.dergeorg.drawboard.integration.collab.COLLAB_ISSUER
import at.dergeorg.drawboard.integration.collab.GuestIntegrationTest
import at.dergeorg.drawboard.integration.collab.PUBLIC_URL
import at.dergeorg.drawboard.integration.collab.SharingUser
import at.dergeorg.drawboard.integration.collab.SignedTokens
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundRevealed
import at.dergeorg.drawboard.shared.auditing.AuditLog
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.boot.micrometer.tracing.test.autoconfigure.AutoConfigureTracing
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.r2dbc.core.DatabaseClient
import org.springframework.test.context.ContextConfiguration
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import tools.jackson.databind.json.JsonMapper
import at.dergeorg.drawboard.shared.testing.PostgresTestcontainerInitializer
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

/**
 * Planning poker end to end (S7.6, contract 2.0.0, M4 contract review): rounds, joining, votes, the reveal, the polls with
 * `ETag`/304, the caps, the rate limits, pruning, the trash, guests and the revocation of their link. Really signed tokens and a
 * real port; guests are switched on. The caps are lowered (4 participants, 3 guests, 2 guests per link, 2 closed rounds) so a cap is
 * reached with a few requests; the rates are the real ones (S7.3).
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "OIDC_ISSUER_URI=$COLLAB_ISSUER",
        "OIDC_AUDIENCE=drawboard-api",
        "DRAWBOARD_PUBLIC_URL=$PUBLIC_URL",
        "DRAWBOARD_GUESTS_ENABLED=true",
        "DRAWBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1",
        "management.otlp.metrics.export.enabled=false",
        "planning.max-participants=4",
        "planning.max-guests=3",
        "planning.max-guests-per-share=2",
        "planning.max-closed-rounds=2",
    ],
)
@AutoConfigureWebTestClient(timeout = "PT30S")
@AutoConfigureTracing
@ContextConfiguration(initializers = [PostgresTestcontainerInitializer::class])
class PlanningIntegrationTest(
    private val client: WebTestClient,
    @LocalServerPort private val port: Int,
    private val json: JsonMapper,
    private val database: DatabaseClient,
    private val auditLog: AuditLog,
) {

    private fun user(name: String) = SharingUser(client, port, name)

    private fun SharingUser.act() = actor(json)

    /** A board with one user of each role. */
    inner class Team {
        val owner = user("Olga")
        val editor = user("Edna")
        val commenter = user("Cleo")
        val viewer = user("Vic")
        val board = owner.createBoard("Sprint").also { board ->
            owner.grantUser("boards", board.id, editor, GrantRole.EDITOR)
            owner.grantUser("boards", board.id, commenter, GrantRole.COMMENTER)
            owner.grantUser("boards", board.id, viewer, GrantRole.VIEWER)
        }
        val ownerApi = owner.act()
        val editorApi = editor.act()
        val commenterApi = commenter.act()
        val viewerApi = viewer.act()
    }

    @Nested
    inner class Starting {

        @Test
        fun `when an editor starts a round then 201 with the Location, the editor as facilitator, an open round and the fibonacci deck`() {
            val team = Team()

            val reply = team.editorApi.create(team.board.id, title = "  Login page  ")

            assertEquals(HttpStatus.CREATED, reply.status, "created, body ${reply.body}")
            val round = reply.round()
            assertEquals("/api/boards/${team.board.id}/poker-rounds/${round.id}", reply.headers.location?.path, "Location of getPokerRound")
            assertEquals(PokerRoundState.OPEN to team.editor.id, round.state to round.facilitatorId, "open, facilitated by the editor")
            assertEquals("Login page", round.title, "the server trims the title")
            assertEquals(listOf("0", "1", "2", "3", "5", "8", "13", "21", "?", "coffee"), round.deck.propertyValues, "fibonacci")
            assertEquals(emptyList(), round.participants, "nobody joined yet")
        }

        @Test
        fun `when the owner starts a round then it works too, with a t-shirt deck and a custom deck`() {
            val team = Team()

            val tshirt = team.ownerApi.start(team.board.id, deck = PokerDeck(PokerDeckKind.TSHIRT))
            val custom = team.ownerApi.start(team.board.id, deck = PokerDeck(PokerDeckKind.CUSTOM, listOf("1", "2", "4", "8", "16", "?")))

            assertEquals(listOf("XS", "S", "M", "L", "XL", "?"), tshirt.deck.propertyValues, "t-shirt")
            assertEquals(listOf("1", "2", "4", "8", "16", "?"), custom.deck.propertyValues, "custom, in the order given")
        }

        @Test
        fun `when a commenter or a viewer starts a round then 403 LIBRARY_BOARD_ACCESS_DENIED`() {
            val team = Team()

            team.commenterApi.create(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "commenter")
            team.viewerApi.create(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "viewer")
        }

        @Test
        fun `when somebody without a role starts a round then 404 LIBRARY_BOARD_NOT_FOUND, as for a board that does not exist`() {
            val team = Team()
            val stranger = user("Sam").act()

            stranger.create(team.board.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "stranger")
            team.ownerApi.create(Uuid.random()).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "no such board")
        }

        @Test
        fun `when a story card already has an open round then 409 PLANNING_ROUND_ALREADY_OPEN with the open round's id`() {
            val team = Team()
            val story = Uuid.random().toString()
            val first = team.editorApi.start(team.board.id, story)

            val second = team.ownerApi.create(team.board.id, story)

            second.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_ALREADY_OPEN, "second round on one card")
            assertEquals(first.id.toString(), second.error().params?.get("roundId"), "params.roundId is the open round")
        }

        @Test
        fun `when a board has 10 open rounds then the 11th is 409 PLANNING_ROUND_LIMIT_REACHED with limit 10`() {
            val team = Team()
            // 10 rounds per user and minute: three people start them
            repeat(5) { team.ownerApi.start(team.board.id) }
            repeat(5) { team.editorApi.start(team.board.id) }
            val thirdEditor = user("Eli").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }.act()

            val eleventh = thirdEditor.create(team.board.id)

            eleventh.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_LIMIT_REACHED, "11th open round")
            assertEquals("10", eleventh.error().params?.get("limit"), "params.limit")
        }

        @Test
        fun `when a user starts an 11th round within a minute then 429 with Retry-After`() {
            val team = Team()
            repeat(10) { team.ownerApi.start(team.board.id) }

            val reply = team.ownerApi.create(team.board.id)

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, reply.status, "10 creates per user and minute")
            assertEquals(ErrorCode.TOO_MANY_REQUESTS, reply.error().code, "error code")
            assertNotNull(reply.headers.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }

        @Test
        fun `when title or deck values have control or format characters or equal NFC forms then 400 VALIDATION_FAILED`() {
            val team = Team()
            val story = { Uuid.random().toString() }

            listOf("two\nlines", "zero​width", "bidi‮override").forEach { title ->
                team.ownerApi.create(team.board.id, story(), title).assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                    "title $title")
            }
            listOf(listOf("a", "b\u0007"), listOf("x‍y", "2"), listOf("é", "é"), listOf("only")).forEach { values ->
                val deck = PokerDeck(PokerDeckKind.CUSTOM, values)
                team.ownerApi.create(team.board.id, story(), deck = deck).assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                    "deck $values")
            }
        }

        @Test
        fun `when the story block id is not a lowercase uuid then 400 VALIDATION_FAILED`() {
            val team = Team()

            val reply = team.ownerApi.call(HttpMethod.POST, "/api/boards/${team.board.id}/poker-rounds",
                NewPokerRound(title = "Story", deck = PokerDeck(PokerDeckKind.TSHIRT), storyBlockId = "NOT-A-UUID"))

            reply.assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, "story block id")
        }

        @Test
        fun `when a round is started then the audit trail has one event with board, story block and facilitator`() = runBlocking {
            val team = Team()
            val story = Uuid.random().toString()

            val round = team.editorApi.start(team.board.id, story)

            val event = auditLog.history("round", round.id.toString()).single()
            assertEquals("planning.round.created", event.eventType, "event type")
            assertTrue(event.details.toString().contains(story) && event.details.toString().contains(team.editor.id.toString()),
                "story block and facilitator in the details: ${event.details}")
        }
    }

    @Nested
    inner class QuickRounds {

        @Test
        fun `when an editor starts a round without a story card then 201, the answer has no storyBlockId and the audit names none`() =
            runBlocking {
                val team = Team()

                val reply = team.editorApi.create(team.board.id, storyBlockId = null, title = "Quick round")

                assertEquals(HttpStatus.CREATED, reply.status, "created, body ${reply.body}")
                val round = reply.round()
                assertNull(round.storyBlockId, "no card")
                assertFalse(reply.body.contains("storyBlockId"), "absent, not null, in the JSON: ${reply.body}")
                assertEquals(PokerRoundState.OPEN to "Quick round", round.state to round.title, "open, with its title")
                val event = auditLog.history("round", round.id.toString()).single()
                assertEquals("planning.round.created", event.eventType, "audited like any round")
                assertFalse(Regex("storyBlockId\\W+[0-9a-f]{8}-").containsMatchIn(event.details.toString()),
                    "no story block in the details: ${event.details}")
            }

        @Test
        fun `when a quick round is voted on, polled and revealed then members and guests see the result as for any round`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id, storyBlockId = null)
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val guest = guestActor(client, json, openAsGuest(client, json, token, "Gus"))

            assertEquals(listOf(round.id), guest.list(team.board.id).rounds().items.map { it.id }, "a guest finds it in the open list")
            assertEquals(HttpStatus.NO_CONTENT, team.commenterApi.vote(team.board.id, round.id, "3").status, "a commenter votes")
            assertEquals(HttpStatus.NO_CONTENT, guest.vote(team.board.id, round.id, "5").status, "a COMMENTER-link guest votes")
            val polled = team.viewerApi.get(team.board.id, round.id)
            assertEquals(HttpStatus.NOT_MODIFIED, team.viewerApi.get(team.board.id, round.id, polled.etag).status, "polling as usual")

            val revealed = team.editorApi.reveal(team.board.id, round.id)

            assertEquals(HttpStatus.OK, revealed.status, "revealed, body ${revealed.body}")
            val result = assertNotNull(revealed.round().result, "result")
            assertEquals(
                setOf(false to "3", true to "5"),
                result.votes.map { it.guest to it.value }.toSet(),
                "every vote, the guest's marked (order is not the point here)",
            )
            assertEquals(4.0 to "5", result.average to result.suggestion, "average and suggestion")
            assertNull(revealed.round().storyBlockId, "still no card")
            assertEquals(PokerRoundState.REVEALED, guest.get(team.board.id, round.id).round().state, "the guest took part and sees it")
        }

        @Test
        fun `when a guest holds a VIEWER link then a quick round is 403 FORBIDDEN as any other`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id, storyBlockId = null)
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.VIEWER)
            val guest = guestActor(client, json, openAsGuest(client, json, token, "Vera"))

            guest.get(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "get")
            guest.vote(team.board.id, round.id, "5").assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "vote")
        }

        @Test
        fun `when a quick round is cancelled then its votes are gone and only the facilitator or the owner may do it`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id, storyBlockId = null)
            team.commenterApi.vote(team.board.id, round.id, "8")

            team.commenterApi.cancel(team.board.id, round.id)
                .assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED, "a commenter")
            val cancelled = team.editorApi.cancel(team.board.id, round.id)

            assertEquals(HttpStatus.OK, cancelled.status, "cancelled, body ${cancelled.body}")
            assertEquals(PokerRoundState.CANCELLED, cancelled.round().state, "state")
            assertNull(team.commenterApi.get(team.board.id, round.id).round().myVote, "the vote is gone")
        }

        @Test
        fun `when two quick rounds are started then both are open at once - one round per card does not apply`() {
            val team = Team()

            val first = team.editorApi.start(team.board.id, storyBlockId = null)
            val second = team.ownerApi.start(team.board.id, storyBlockId = null)

            assertEquals(setOf(first.id, second.id), team.viewerApi.list(team.board.id).rounds().items.map { it.id }.toSet(), "both open")
        }

        @Test
        fun `when quick rounds and rounds on cards together reach 10 then the 11th is 409 PLANNING_ROUND_LIMIT_REACHED`() {
            val team = Team()
            repeat(5) { team.ownerApi.start(team.board.id, storyBlockId = null) }
            repeat(5) { team.editorApi.start(team.board.id) }
            val thirdEditor = user("Eli").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }.act()

            thirdEditor.create(team.board.id, storyBlockId = null)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_LIMIT_REACHED, "11th open round, quick")
            thirdEditor.create(team.board.id)
                .assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_LIMIT_REACHED, "11th open round, on a card")
        }
    }

    @Nested
    inner class Reading {

        @Test
        fun `when rounds are listed then the open ones come newest first, a state filter picks the others and every role may read`() {
            val team = Team()
            val first = team.ownerApi.start(team.board.id)
            Thread.sleep(5)
            val second = team.ownerApi.start(team.board.id)
            Thread.sleep(5)
            val third = team.ownerApi.start(team.board.id)
            team.ownerApi.reveal(team.board.id, first.id)
            team.ownerApi.cancel(team.board.id, third.id)

            listOf(team.viewerApi, team.commenterApi, team.ownerApi).forEach { api ->
                assertEquals(listOf(second.id), api.list(team.board.id).rounds().items.map { it.id }, "open (the default)")
            }
            assertEquals(listOf(first.id), team.viewerApi.list(team.board.id, "REVEALED").rounds().items.map { it.id }, "revealed")
            assertEquals(listOf(third.id), team.viewerApi.list(team.board.id, "CANCELLED").rounds().items.map { it.id }, "cancelled")
            team.viewerApi.list(team.board.id, "DONE").assertCode(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, "unknown state")
        }

        @Test
        fun `when more than 30 lists per user and board come in a minute then 429`() {
            val team = Team()
            repeat(30) { assertEquals(HttpStatus.OK, team.viewerApi.list(team.board.id).status, "list $it") }

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, team.viewerApi.list(team.board.id).status, "31st list")
            assertEquals(HttpStatus.OK, team.commenterApi.list(team.board.id).status, "another user has their own allowance")
        }

        @Test
        fun `when a commenter or higher fetches an open round then they are listed with voted false, a viewer is not`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)

            val viewerSees = team.viewerApi.get(team.board.id, round.id).round()
            val commenterSees = team.commenterApi.get(team.board.id, round.id).round()

            assertEquals(emptyList(), viewerSees.participants, "viewers see the round without being listed")
            assertEquals(listOf("Cleo" to false), commenterSees.participants.map { it.displayName to it.voted }, "the commenter joined")
            assertEquals(viewerSees.version + 1, commenterSees.version, "a join raises the version")
            assertEquals(commenterSees.version, team.commenterApi.get(team.board.id, round.id).round().version,
                "joining twice changes nothing")
        }

        @Test
        fun `when a round of another board or an unknown round is asked for then 404 PLANNING_ROUND_NOT_FOUND`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val otherBoard = team.owner.createBoard("Other")

            team.ownerApi.get(otherBoard.id, round.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_ROUND_NOT_FOUND, "other board")
            team.ownerApi.get(team.board.id, Uuid.random()).assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_ROUND_NOT_FOUND, "unknown")
            team.ownerApi.vote(otherBoard.id, round.id, "5").assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_ROUND_NOT_FOUND, "vote")
            team.ownerApi.reveal(otherBoard.id, round.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_ROUND_NOT_FOUND, "reveal")
        }

        @Test
        fun `when somebody without a role on the board reads a round then 404 LIBRARY_BOARD_NOT_FOUND`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val stranger = user("Sam").act()

            stranger.get(team.board.id, round.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "get")
            stranger.list(team.board.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "list")
        }

        @Test
        fun `when no token is sent then 401`() {
            val team = Team()
            val anonymous = Actor(client, json)

            assertEquals(HttpStatus.UNAUTHORIZED, anonymous.list(team.board.id).status, "list")
            assertEquals(HttpStatus.UNAUTHORIZED, anonymous.get(team.board.id, Uuid.random()).status, "get")
        }
    }

    @Nested
    inner class Polling {

        @Test
        fun `when the round is unchanged then the same If-None-Match gets 304 without a body but with ETag, no-store and Vary`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val first = team.commenterApi.get(team.board.id, round.id)

            val second = team.commenterApi.get(team.board.id, round.id, ifNoneMatch = first.etag)

            assertEquals("W/\"${first.round().version}\"", first.etag, "the ETag is the weak validator of the version")
            assertEquals(HttpStatus.NOT_MODIFIED, second.status, "unchanged")
            assertEquals("", second.body, "no body")
            assertEquals(first.etag, second.etag, "the 304 carries the ETag")
            assertEquals("no-store", second.headers.cacheControl, "no-store on the 304")
            assertEquals("no-store", first.headers.cacheControl, "no-store on the 200")
            assertEquals(listOf("Authorization"), second.headers.vary, "Vary: Authorization on the 304")
            assertEquals(listOf("Authorization"), first.headers.vary, "Vary: Authorization on the 200")
        }

        @Test
        fun `when the tag is sent in the strong form or in a list then weak comparison still gives 304`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val version = team.commenterApi.get(team.board.id, round.id).round().version

            assertEquals(HttpStatus.NOT_MODIFIED, team.commenterApi.get(team.board.id, round.id, "\"$version\"").status, "strong form")
            assertEquals(HttpStatus.NOT_MODIFIED, team.commenterApi.get(team.board.id, round.id, "W/\"0\", W/\"$version\"").status,
                "a list")
        }

        @Test
        fun `when If-None-Match is a star or a stale tag then 200 - a star counts as no match`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val version = team.commenterApi.get(team.board.id, round.id).round().version

            assertEquals(HttpStatus.OK, team.commenterApi.get(team.board.id, round.id, "*").status, "a star is no match")
            assertEquals(HttpStatus.OK, team.commenterApi.get(team.board.id, round.id, "W/\"${version - 1}\"").status, "stale")
            assertEquals(HttpStatus.OK, team.commenterApi.get(team.board.id, round.id, "garbage").status, "not a tag")
        }

        @Test
        fun `when somebody joins or votes for the first time then the ETag changes, when a vote is only changed it does not`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val tag = team.commenterApi.get(team.board.id, round.id).etag

            assertEquals(HttpStatus.NO_CONTENT, team.editorApi.vote(team.board.id, round.id, "5").status, "a new voter joins")
            val afterJoin = team.commenterApi.get(team.board.id, round.id, tag)
            assertEquals(HttpStatus.OK, afterJoin.status, "a join is a change")

            team.editorApi.vote(team.board.id, round.id, "8")
            team.editorApi.vote(team.board.id, round.id, "8")
            assertEquals(HttpStatus.NOT_MODIFIED, team.commenterApi.get(team.board.id, round.id, afterJoin.etag).status,
                "a changed vote is not noticed by the others")

            assertEquals(HttpStatus.NO_CONTENT, team.commenterApi.vote(team.board.id, round.id, "3").status,
                "the first vote of a participant")
            assertEquals(HttpStatus.OK, team.editorApi.get(team.board.id, round.id, afterJoin.etag).status, "a first vote is a change")
        }

        @Test
        fun `when the round is revealed or cancelled then the version rises - the poll learns it`() {
            val team = Team()
            val revealed = team.ownerApi.start(team.board.id)
            val cancelled = team.ownerApi.start(team.board.id)
            val revealedTag = team.commenterApi.get(team.board.id, revealed.id).etag
            val cancelledTag = team.commenterApi.get(team.board.id, cancelled.id).etag

            team.ownerApi.reveal(team.board.id, revealed.id)
            team.ownerApi.cancel(team.board.id, cancelled.id)

            assertEquals(PokerRoundState.REVEALED, team.commenterApi.get(team.board.id, revealed.id, revealedTag).also {
                assertEquals(HttpStatus.OK, it.status, "reveal is a change")
            }.round().state, "revealed")
            assertEquals(PokerRoundState.CANCELLED, team.commenterApi.get(team.board.id, cancelled.id, cancelledTag).also {
                assertEquals(HttpStatus.OK, it.status, "cancel is a change")
            }.round().state, "cancelled")
        }

        @Test
        fun `when a user polls more than 60 times a minute then 429 with Retry-After - a 304 counts as well`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val tag = team.commenterApi.get(team.board.id, round.id).etag
            repeat(59) { assertEquals(HttpStatus.NOT_MODIFIED, team.commenterApi.get(team.board.id, round.id, tag).status, "poll $it") }

            val over = team.commenterApi.get(team.board.id, round.id, tag)

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, over.status, "the 61st call")
            assertNotNull(over.headers.getFirst(HttpHeaders.RETRY_AFTER), "Retry-After")
        }
    }

    @Nested
    inner class Voting {

        @Test
        fun `when a commenter votes then 204, they are listed as voted, see their own value, and the others see only that they voted`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id, deck = PokerDeck(PokerDeckKind.CUSTOM, listOf("zzq1", "zzq2", "zzq3")))

            assertEquals(HttpStatus.NO_CONTENT, team.commenterApi.vote(team.board.id, round.id, "zzq2").status, "vote stored")

            val mine = team.commenterApi.get(team.board.id, round.id)
            assertEquals("zzq2", mine.round().myVote, "myVote")
            val theirs = team.ownerApi.get(team.board.id, round.id)
            assertNull(theirs.round().myVote, "the owner has not voted")
            assertTrue(!theirs.body.contains("myVote") && !team.viewerApi.get(team.board.id, round.id).body.contains("myVote"),
                "nobody sees the value while the round is open - not even the owner of the board")
            assertNull(theirs.round().result, "and there is no result")
            assertEquals(true, theirs.round().participants.single { it.displayName == "Cleo" }.voted, "but that Cleo voted")
        }

        @Test
        fun `when a viewer votes then 403 LIBRARY_BOARD_ACCESS_DENIED`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)

            team.viewerApi.vote(team.board.id, round.id, "5").assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "viewer")
        }

        @Test
        fun `when the value is no card of the deck then 400 PLANNING_VALUE_INVALID that never echoes the value`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)

            val reply = team.commenterApi.vote(team.board.id, round.id, "nope")

            reply.assertCode(HttpStatus.BAD_REQUEST, ErrorCode.PLANNING_VALUE_INVALID, "not in the deck")
            assertFalse(reply.body.contains("nope"), "the value is not in the answer: ${reply.body}")
            assertNull(reply.error().params?.get("value"), "params.value is absent")
            team.commenterApi.vote(team.board.id, round.id, "coffee").also { assertEquals(HttpStatus.NO_CONTENT, it.status,
                "coffee is a card") }
        }

        @Test
        fun `when more than 30 votes per user and round come in a minute then 429`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            repeat(30) { assertEquals(HttpStatus.NO_CONTENT, team.commenterApi.vote(team.board.id, round.id, "5").status, "vote $it") }

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, team.commenterApi.vote(team.board.id, round.id, "5").status, "31st vote")
        }

        @Test
        fun `when the round is full then a new voter gets 409 PLANNING_ROUND_FULL, getting it still works, participants may change`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val others = List(3) { user("P$it").also { u -> team.owner.grantUser("boards", team.board.id, u, GrantRole.COMMENTER) }.act() }
            others.forEach { assertEquals(HttpStatus.NO_CONTENT, it.vote(team.board.id, round.id, "3").status, "fills a seat") }
            assertEquals(HttpStatus.NO_CONTENT, team.commenterApi.vote(team.board.id, round.id, "3").status, "fourth seat")
            val late = user("Late").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }.act()

            val full = late.vote(team.board.id, round.id, "8")
            val seen = late.get(team.board.id, round.id)

            full.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_FULL, "fifth voter")
            assertEquals("4", full.error().params?.get("limit"), "params.limit is the cap that was hit")
            assertEquals(round.id.toString(), full.error().params?.get("roundId"), "params.roundId")
            assertEquals(HttpStatus.OK, seen.status, "getPokerRound never fails from the cap")
            assertEquals(4, seen.round().participants.size, "the caller is not listed")
            assertEquals(HttpStatus.NO_CONTENT, others[0].vote(team.board.id, round.id, "13").status,
                "a participant may still change their vote")
        }

        @Test
        fun `when the round is closed then a vote is 409 PLANNING_ROUND_CLOSED with the state`() {
            val team = Team()
            val revealed = team.ownerApi.start(team.board.id)
            val cancelled = team.ownerApi.start(team.board.id)
            team.ownerApi.reveal(team.board.id, revealed.id)
            team.ownerApi.cancel(team.board.id, cancelled.id)

            val afterReveal = team.commenterApi.vote(team.board.id, revealed.id, "5")
            val afterCancel = team.commenterApi.vote(team.board.id, cancelled.id, "5")

            afterReveal.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_CLOSED, "after the reveal")
            assertEquals("REVEALED", afterReveal.error().params?.get("state"), "params.state")
            assertEquals("CANCELLED", afterCancel.error().params?.get("state"), "params.state after the cancel")
        }
    }

    @Nested
    inner class Closing {

        @Test
        fun `when the facilitator reveals then 200 with every vote, the result and revealedAt, and the owner and others see it too`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id)
            team.commenterApi.vote(team.board.id, round.id, "5")
            team.ownerApi.vote(team.board.id, round.id, "8")
            team.editorApi.vote(team.board.id, round.id, "5")
            team.editorApi.get(team.board.id, round.id) // already a participant

            val reply = team.editorApi.reveal(team.board.id, round.id)

            assertEquals(HttpStatus.OK, reply.status, "revealed, body ${reply.body}")
            val revealed = reply.round()
            assertEquals(PokerRoundState.REVEALED, revealed.state, "state")
            assertNotNull(revealed.revealedAt, "revealedAt")
            val result = assertNotNull(revealed.result, "result")
            assertEquals(listOf("Cleo" to "5", "Olga" to "8", "Edna" to "5"), result.votes.map { it.displayName to it.value },
                "votes in joining order")
            assertEquals(6.0, result.average, "average of 5, 8, 5")
            assertEquals(5.0, result.median, "median")
            assertEquals("5", result.suggestion, "suggestion")
            assertEquals(listOf("5" to 2, "8" to 1), result.distribution.map { it.value to it.count }, "distribution in deck order")
            val seenByViewer = team.viewerApi.get(team.board.id, round.id).round()
            assertEquals(3, seenByViewer.result?.votes?.size, "everybody sees the result afterwards")
            assertEquals("5", team.commenterApi.get(team.board.id, round.id).round().myVote, "myVote stays")
        }

        @Test
        fun `when the round is revealed then the audit trail counts members and guests and holds no individual vote`() = runBlocking {
            val team = Team()
            val round = team.editorApi.start(team.board.id, deck = PokerDeck(PokerDeckKind.CUSTOM, listOf("zzq7", "zzq8", "zzq9")))
            team.commenterApi.vote(team.board.id, round.id, "zzq7")
            team.ownerApi.vote(team.board.id, round.id, "zzq9")
            team.editorApi.get(team.board.id, round.id)

            team.editorApi.reveal(team.board.id, round.id)

            val events = auditLog.history("round", round.id.toString())
            assertEquals(listOf("planning.round.created", "planning.round.revealed"), events.map { it.eventType },
                "no join and no vote is audited")
            val details = assertNotNull(events.last().detailsAs<RoundRevealed>(), "typed details")
            assertEquals(2 to 0, details.memberVotes to details.guestVotes, "two member votes, no guest vote")
            assertEquals(team.editor.id.toString(), details.actorId, "actor")
            assertTrue(events.none { it.toString().contains("zzq") }, "no vote value anywhere in the audit")
        }

        @Test
        fun `when a round with zero votes is revealed then it is allowed and the result is empty`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)

            val result = assertNotNull(team.ownerApi.reveal(team.board.id, round.id).round().result, "result")

            assertEquals(emptyList(), result.votes, "no votes")
            assertNull(result.suggestion, "no suggestion")
        }

        @Test
        fun `when another editor or a commenter reveals then 403 LIBRARY_BOARD_ACCESS_DENIED, the owner may always`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id)
            val otherEditor = user("Eve").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }.act()

            otherEditor.reveal(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "other editor")
            team.commenterApi.reveal(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "commenter")
            team.viewerApi.cancel(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "viewer cancel")
            otherEditor.cancel(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "other editor cancel")
            assertEquals(HttpStatus.OK, team.ownerApi.reveal(team.board.id, round.id).status, "the owner reveals a round of an editor")
        }

        @Test
        fun `when the facilitator lost their editor role then they cannot reveal or cancel any more`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id)
            assertEquals(HttpStatus.OK, team.owner.status("PUT", "/api/boards/${team.board.id}/members/users/${team.editor.id}",
                MemberUpdate(GrantRole.COMMENTER)), "demoted")

            team.editorApi.reveal(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "demoted facilitator")
            team.editorApi.cancel(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.LIBRARY_BOARD_ACCESS_DENIED,
                "demoted facilitator cancel")
        }

        @Test
        fun `when a closed round is revealed or cancelled again then 409 PLANNING_ROUND_CLOSED, both are final`() {
            val team = Team()
            val revealed = team.ownerApi.start(team.board.id)
            val cancelled = team.ownerApi.start(team.board.id)
            team.ownerApi.reveal(team.board.id, revealed.id)
            team.ownerApi.cancel(team.board.id, cancelled.id)

            team.ownerApi.reveal(team.board.id, revealed.id).assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_CLOSED,
                "reveal again")
            team.ownerApi.cancel(team.board.id, revealed.id).assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_CLOSED,
                "cancel after reveal")
            team.ownerApi.reveal(team.board.id, cancelled.id).assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_CLOSED,
                "reveal after cancel")
        }

        @Test
        fun `when a round is cancelled then its votes are gone for good and the round shows none`() = runBlocking {
            val team = Team()
            val round = team.ownerApi.start(team.board.id, deck = PokerDeck(PokerDeckKind.CUSTOM, listOf("zzq1", "zzq2")))
            team.commenterApi.vote(team.board.id, round.id, "zzq2")

            val cancelled = team.ownerApi.cancel(team.board.id, round.id)

            assertEquals(HttpStatus.OK, cancelled.status, "cancelled")
            assertEquals(PokerRoundState.CANCELLED, cancelled.round().state, "state")
            assertNull(cancelled.round().result, "never revealed")
            val stored = database.sql("select count(*) as n from planning.poker_participant " +
                "where round_id = cast(:id as uuid) and vote is not null")
                .bind("id", round.id.toString()).fetch().one().block()!!["n"] as Long
            assertEquals(0L, stored, "the votes are deleted in the database")
            val after = team.commenterApi.get(team.board.id, round.id).round()
            assertNull(after.myVote, "not even their owner sees it")
            assertEquals(listOf(false), after.participants.map { it.voted }, "nobody has voted any more")
            assertEquals(listOf("planning.round.created", "planning.round.cancelled"),
                auditLog.history("round", round.id.toString()).map { it.eventType }, "audited")
        }
    }

    @Nested
    inner class Lifecycle {

        @Test
        fun `when a board has too many closed rounds then a create prunes the oldest cancelled first, then the oldest revealed`() {
            val team = Team()
            val revealed = mutableListOf<Uuid>()
            val cancelled = mutableListOf<Uuid>()
            repeat(2) { team.ownerApi.start(team.board.id).also { r -> team.ownerApi.reveal(team.board.id,
                r.id); revealed += r.id }; Thread.sleep(5) }
            repeat(2) { team.ownerApi.start(team.board.id).also { r -> team.ownerApi.cancel(team.board.id,
                r.id); cancelled += r.id }; Thread.sleep(5) }
            val voted = team.ownerApi.start(team.board.id)
            team.commenterApi.vote(team.board.id, voted.id, "5")

            team.ownerApi.start(team.board.id) // four closed rounds, the limit is two: the two oldest cancelled ones go

            val kept = team.ownerApi.list(team.board.id, "REVEALED").rounds().items.map { it.id }.toSet() +
                team.ownerApi.list(team.board.id, "CANCELLED").rounds().items.map { it.id }.toSet()
            assertEquals(revealed.toSet(), kept, "the cancelled ones were pruned first")
            team.ownerApi.start(team.board.id)
            val left = team.ownerApi.list(team.board.id, "REVEALED").rounds().items.size
            assertEquals(2, left, "two revealed ones remain")

            repeat(3) { team.editorApi.start(team.board.id).also { r -> team.editorApi.reveal(team.board.id, r.id) }; Thread.sleep(5) }
            team.editorApi.start(team.board.id)
            val remaining = team.ownerApi.list(team.board.id, "REVEALED").rounds().items.map { it.id }
            assertEquals(2, remaining.size, "revealed rounds are pruned to the limit as well")
            assertTrue(remaining.none { it in revealed }, "and it was the oldest ones")
        }

        @Test
        fun `when a board goes to the trash then its rounds answer 404 and a purge deletes them with their votes`() = runBlocking {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            team.commenterApi.vote(team.board.id, round.id, "5")
            assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/boards/${team.board.id}"), "to the trash")

            team.ownerApi.get(team.board.id, round.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND,
                "get in the trash")
            team.ownerApi.list(team.board.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "list in the trash")
            team.commenterApi.vote(team.board.id, round.id, "8").assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND,
                "vote in the trash")
            assertEquals(1L, count("poker_round", round.id), "the round is kept while the board is in the trash")

            assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/trash/boards/${team.board.id}"), "purged for good")

            assertEquals(0L, count("poker_round", round.id), "the round is deleted with the board")
            assertEquals(0L,
                database.sql("select count(*) as n from planning.poker_participant where round_id = cast(:id as uuid)").bind("id",
                    round.id.toString())
                .fetch().one().block()!!["n"] as Long, "and its participants and votes")
        }

        private fun count(table: String, roundId: Uuid) =
            database.sql("select count(*) as n from planning.$table where id = cast(:id as uuid)").bind("id",
                roundId.toString()).fetch().one().block()!!["n"] as Long

        @Test
        fun `when a participant's user does not exist any more then the round reads Deleted user for them and for the facilitator`() {
            val team = Team()
            val facilitator = user("Fay").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.EDITOR) }
            val voter = user("Vera").also { team.owner.grantUser("boards", team.board.id, it, GrantRole.COMMENTER) }
            val round = facilitator.act().start(team.board.id)
            voter.act().vote(team.board.id, round.id, "5")
            val before = team.viewerApi.get(team.board.id, round.id).round()
            assertEquals("Fay", before.facilitatorName, "name before")
            assertEquals(listOf("Vera"), before.participants.map { it.displayName }, "participant before")

            listOf(facilitator.id, voter.id).forEach {
                database.sql("delete from users.user_profile where id = cast(:id as uuid)").bind("id",
                    it.toString()).fetch().rowsUpdated().block()
            }

            val after = team.viewerApi.get(team.board.id, round.id).round()
            assertEquals("Deleted user", after.facilitatorName, "facilitator")
            assertEquals(listOf("Deleted user"), after.participants.map { it.displayName }, "participant")
            team.ownerApi.reveal(team.board.id, round.id)
            assertEquals(listOf("Deleted user"), team.viewerApi.get(team.board.id, round.id).round().result?.votes?.map { it.displayName },
                "result vote")
        }

        @Test
        fun `when a member left the board then the round still shows their name - the round is a record`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            team.commenterApi.vote(team.board.id, round.id, "5")
            team.owner.status("DELETE", "/api/boards/${team.board.id}/members/users/${team.commenter.id}")

            val seen = team.viewerApi.get(team.board.id, round.id).round()

            assertEquals(listOf("Cleo"), seen.participants.map { it.displayName }, "names stay")
            assertFalse(seen.participants.any { it.displayName == team.commenter.id.toString() }, "never a user id")
        }

        @Test
        fun `when the round is read then no user id of a participant appears in the body, only the facilitator's`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id)
            team.commenterApi.vote(team.board.id, round.id, "5")

            val body = team.ownerApi.get(team.board.id, round.id).body

            assertFalse(body.contains(team.commenter.id.toString()), "participants have no ids in the contract")
            assertTrue(body.contains(team.editor.id.toString()), "the facilitator's id is there for members")
        }
    }

    @Nested
    inner class Guests {

        private fun guestOf(team: Team, role: GrantRole, name: String = "Gus"): Triple<Actor, Uuid, String> {
            val (token, linkId) = guestLink(team.owner, "boards", team.board.id, role)
            return Triple(guestActor(client, json, openAsGuest(client, json, token, name)), linkId, token)
        }

        @Test
        fun `when a guest holds a VIEWER link then 403 FORBIDDEN on list, get and vote`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (guest, _, _) = guestOf(team, GrantRole.VIEWER)

            guest.list(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "list")
            guest.get(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "get")
            guest.vote(team.board.id, round.id, "5").assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "vote")
        }

        @Test
        fun `when a guest with a COMMENTER link lists then only OPEN rounds, any other state is 403, and facilitatorId is left out`() {
            val team = Team()
            val round = team.editorApi.start(team.board.id)
            val (guest, _, _) = guestOf(team, GrantRole.COMMENTER)

            val open = guest.list(team.board.id)

            assertEquals(listOf(round.id), open.rounds().items.map { it.id }, "the open round")
            assertNull(open.rounds().items.single().facilitatorId, "no member id for a guest")
            assertFalse(open.body.contains(team.editor.id.toString()), "the member's id is nowhere in the body")
            assertEquals("Edna", open.rounds().items.single().facilitatorName, "but the facilitator's name")
            guest.list(team.board.id, "OPEN").also { assertEquals(HttpStatus.OK, it.status, "explicit OPEN") }
            guest.list(team.board.id, "REVEALED").assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "revealed")
            guest.list(team.board.id, "CANCELLED").assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "cancelled")
        }

        @Test
        fun `when a guest fetches a round then it is not added, and only a vote adds it - with guest true and its name`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (guest, _, _) = guestOf(team, GrantRole.COMMENTER, "Gus Guest")

            val looked = guest.get(team.board.id, round.id).round()
            assertEquals(emptyList(), looked.participants, "getPokerRound never adds a guest")
            assertEquals(looked.version, team.viewerApi.get(team.board.id, round.id).round().version, "and does not raise the version")

            assertEquals(HttpStatus.NO_CONTENT, guest.vote(team.board.id, round.id, "5").status, "a guest votes")
            val listed = team.viewerApi.get(team.board.id, round.id).round()
            assertEquals(listOf(Triple("Gus Guest", true, true)), listed.participants.map { Triple(it.displayName, it.guest, it.voted) },
                "listed as a guest")
            assertEquals("5", guest.get(team.board.id, round.id).round().myVote, "the guest's own vote")
            assertEquals(looked.version + 1, listed.version, "the vote raised the version")
            assertEquals(HttpStatus.NOT_MODIFIED, guest.get(team.board.id, round.id, guest.get(team.board.id, round.id).etag).status,
                "ETag works for guests")
        }

        @Test
        fun `when a guest exchanges the link again then it is a new participant, visible by guest true`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (first, _, token) = guestOf(team, GrantRole.EDITOR)
            first.vote(team.board.id, round.id, "5")
            val second = guestActor(client, json, openAsGuest(client, json, token, "Gus"))

            second.vote(team.board.id, round.id, "5")

            assertEquals(listOf(true, true), team.viewerApi.get(team.board.id, round.id).round().participants.map { it.guest },
                "two sessions, two participants")
        }

        @Test
        fun `when a guest tries to start, reveal or cancel then 403 FORBIDDEN`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (guest, _, _) = guestOf(team, GrantRole.EDITOR)

            guest.create(team.board.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "create")
            guest.reveal(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "reveal")
            guest.cancel(team.board.id, round.id).assertCode(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "cancel")
        }

        @Test
        fun `when a guest asks about a board outside its link then 404, and below a folder link it works`() {
            val team = Team()
            val other = team.owner.createBoard("Not shared")
            val otherRound = team.ownerApi.start(other.id)
            val (guest, _, _) = guestOf(team, GrantRole.COMMENTER)

            guest.list(other.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "other board of the same owner")
            guest.get(other.id, otherRound.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.LIBRARY_BOARD_NOT_FOUND, "its round")

            val folder = team.owner.createFolder("Team")
            val sub = team.owner.createFolder("Sub", folder.id)
            val below = team.owner.createBoard("Below", sub.id)
            val belowRound = team.ownerApi.start(below.id)
            val (token, _) = guestLink(team.owner, "folders", folder.id, GrantRole.COMMENTER)
            val folderGuest = guestActor(client, json, openAsGuest(client, json, token, "Fran"))

            assertEquals(listOf(belowRound.id), folderGuest.list(below.id).rounds().items.map { it.id }, "a board below the folder")
            assertEquals(HttpStatus.NO_CONTENT, folderGuest.vote(below.id, belowRound.id, "3").status, "vote below the folder")
        }

        @Test
        fun `when a guest looks at a closed round then only a participant sees it, everybody else gets 404 PLANNING_ROUND_NOT_FOUND`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (participant, _, _) = guestOf(team, GrantRole.COMMENTER, "Pat")
            val (stranger, _, _) = guestOf(team, GrantRole.COMMENTER, "Sid")
            participant.vote(team.board.id, round.id, "8")
            team.ownerApi.reveal(team.board.id, round.id)

            val seen = participant.get(team.board.id, round.id).round()

            assertEquals(PokerRoundState.REVEALED, seen.state, "the participant sees the result")
            assertEquals(listOf("Pat" to "8"), seen.result?.votes?.map { it.displayName to it.value }, "with the votes")
            stranger.get(team.board.id, round.id).assertCode(HttpStatus.NOT_FOUND, ErrorCode.PLANNING_ROUND_NOT_FOUND, "not a participant")
            stranger.vote(team.board.id, round.id, "8").assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_CLOSED,
                "vote after the reveal")
        }

        @Test
        fun `when too many guests of one link vote then 409 PLANNING_ROUND_FULL with the per-link limit, and another link has its own`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val sessions = List(3) { guestActor(client, json, openAsGuest(client, json, token, "G$it")) }
            assertEquals(HttpStatus.NO_CONTENT, sessions[0].vote(team.board.id, round.id, "1").status, "first guest")
            assertEquals(HttpStatus.NO_CONTENT, sessions[1].vote(team.board.id, round.id, "1").status, "second guest")

            val third = sessions[2].vote(team.board.id, round.id, "1")

            third.assertCode(HttpStatus.CONFLICT, ErrorCode.PLANNING_ROUND_FULL, "third guest of one link")
            assertEquals("2", third.error().params?.get("limit"), "the per-link cap")
            val (otherToken, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.EDITOR)
            val viaOther = guestActor(client, json, openAsGuest(client, json, otherToken, "Other"))
            assertEquals(HttpStatus.NO_CONTENT, viaOther.vote(team.board.id, round.id, "1").status,
                "a guest of another link (3rd guest overall)")
            val fourth = guestActor(client, json, openAsGuest(client, json, otherToken, "Fourth")).vote(team.board.id, round.id, "1")
            assertEquals("3", fourth.error().params?.get("limit"), "the per-round guest cap")
        }

        @Test
        fun `when guests of one link call a lot then the limits are also keyed by share - 100 votes per share, round and minute`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (token, _) = guestLink(team.owner, "boards", team.board.id, GrantRole.COMMENTER)
            val sessions = List(4) { guestActor(client, json, openAsGuest(client, json, token, "S$it")) }
            var last = HttpStatus.OK

            // 4 sessions x 26 votes: each stays under its own 30 a minute, together they pass the 100 of the share
            repeat(26) { sessions.forEach { s -> last = s.vote(team.board.id, round.id, "1").status } }

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, last, "the share is over its limit although no session is")
        }

        @Test
        fun `when one guest votes more than 30 times a minute then 429 for that session`() {
            val team = Team()
            val round = team.ownerApi.start(team.board.id)
            val (guest, _, _) = guestOf(team, GrantRole.EDITOR)
            repeat(30) { assertEquals(HttpStatus.NO_CONTENT, guest.vote(team.board.id, round.id, "1").status, "vote $it") }

            assertEquals(HttpStatus.TOO_MANY_REQUESTS, guest.vote(team.board.id, round.id, "1").status, "31st vote of the session")
        }

        @Test
        fun `when the link is revoked then its guests leave the open rounds, the version rises, closed rounds keep them`() {
            val team = Team()
            // a name no registered user has: a guest with such a name would get a suffix
            val gus = "Gus ${Uuid.random().toString().take(6)}"
            val open = team.ownerApi.start(team.board.id)
            val closed = team.ownerApi.start(team.board.id)
            val (guest, linkId, _) = guestOf(team, GrantRole.COMMENTER, gus)
            val (other, _, _) = guestOf(team, GrantRole.COMMENTER, "Other")
            guest.vote(team.board.id, open.id, "5")
            other.vote(team.board.id, open.id, "8")
            guest.vote(team.board.id, closed.id, "3")
            team.commenterApi.vote(team.board.id, open.id, "13")
            team.ownerApi.reveal(team.board.id, closed.id)
            val before = team.ownerApi.get(team.board.id, open.id).round()
            assertEquals(listOf(gus, "Other", "Cleo", "Olga"), before.participants.map { it.displayName },
                "two guests and two members before")

            assertEquals(HttpStatus.NO_CONTENT, team.owner.status("DELETE", "/api/links/$linkId"), "revoked")

            val after = team.ownerApi.get(team.board.id, open.id)
            assertEquals(listOf("Other", "Cleo", "Olga"), after.round().participants.map { it.displayName },
                "only the guests of the link left")
            assertEquals(before.version + 1, after.round().version, "the removal raises the version")
            assertFalse(after.round().participants.any { it.displayName == gus }, "the guest is gone from the open round")
            assertEquals(HttpStatus.UNAUTHORIZED, guest.get(team.board.id, open.id).status, "and the session of the link is dead")
            assertTrue(team.ownerApi.get(team.board.id, closed.id).round().result!!.votes.any { it.displayName == gus },
                "the closed round is a record and keeps the guest's vote")
        }
    }

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun properties(registry: DynamicPropertyRegistry) {
            registry.add("OIDC_JWK_SET_URI") { SignedTokens.jwkSetUri }
            registry.add("DRAWBOARD_GUEST_SIGNING_KEYS") { GuestIntegrationTest.generatedKey() }
        }
    }
}
