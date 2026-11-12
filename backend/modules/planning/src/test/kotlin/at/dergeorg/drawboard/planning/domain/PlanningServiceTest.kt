package at.dergeorg.drawboard.planning.domain

import at.dergeorg.drawboard.planning.domain.rounds.PlanningSettings
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundCancelled
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundCreated
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundRevealed
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundState
import at.dergeorg.drawboard.planning.domain.rounds.model.RoundView
import at.dergeorg.drawboard.planning.domain.rounds.provides.CastVoteCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.CreateRoundCommand
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.rounds.provides.GetRoundQuery
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.RateLimitedException
import at.dergeorg.drawboard.shared.testing.MutableClock
import at.dergeorg.drawboard.shared.testing.RecordingAuditTrail
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class PlanningServiceTest {

    private val clock = MutableClock()
    private val rounds = InMemoryRounds()
    private val participants = InMemoryParticipants()
    private val audit = RecordingAuditTrail()
    private val metrics = RecordingMetrics()
    private val shares = FakeGuestShares()
    private val board = Uuid.generateV7()
    private val facilitator = Principal.Member(Uuid.generateV7(), "Fiona")
    private val anna = Principal.Member(Uuid.generateV7(), "Anna")
    private val ben = Principal.Member(Uuid.generateV7(), "Ben")
    private val share = Uuid.generateV7()

    private fun guest(name: String = "Gus", shareId: Uuid = share) = Principal.Guest(Uuid.random(), name, shareId)

    private fun service(settings: PlanningSettings = PlanningSettings()) =
        PlanningService(rounds, participants, DirectTransactions, settings, audit, metrics, clock, shares)

    private fun card() = Uuid.random().toString()

    private suspend fun PlanningService.start(
        storyBlockId: String? = card(),
        deck: DeckSpec = DeckSpec(DeckKind.FIBONACCI, null),
        on: Uuid = board,
    ) = create(CreateRoundCommand(on, storyBlockId, "  Login page ", deck, facilitator))

    private suspend fun PlanningService.fetch(round: RoundView, viewer: Principal, mayJoin: Boolean = viewer is Principal.Member) =
        get(GetRoundQuery(round.boardId, round.id, viewer, mayJoin))

    private suspend fun PlanningService.cast(round: RoundView, voter: Principal, value: String) =
        vote(CastVoteCommand(round.boardId, round.id, voter, value))

    @Nested
    inner class Creating {

        @Test
        fun `when a round is started then it is OPEN with the trimmed title, the fixed deck and no participants, and audited`() = runTest {
            val round = service().start()

            assertEquals("Login page", round.title, "trimmed")
            assertEquals(RoundState.OPEN to listOf("0", "1", "2", "3", "5", "8", "13", "21", "?", "coffee"),
                round.state to round.deck.values, "state and deck")
            assertEquals(emptyList(), round.participants, "the facilitator is not a participant until they fetch or vote")
            val details = assertIs<RoundCreated>(audit.events.single().details, "audit details")
            assertEquals(facilitator.id.toString(), details.facilitatorId, "facilitator in the event")
            assertEquals(listOf("started"), metrics.rounds, "metric")
        }

        @Test
        fun `when a story card already has an open round then 409 PLANNING_ROUND_ALREADY_OPEN names that round`() = runTest {
            val service = service()
            val story = card()
            val first = service.start(story)

            val error = assertFailsWith<DomainException>("second round on the same card") { service.start(story) }

            assertEquals(ErrorCode.PLANNING_ROUND_ALREADY_OPEN, error.errorCode, "code")
            assertEquals(first.id.toString(), error.params["roundId"], "the open one")
        }

        @Test
        fun `when a story card's round was cancelled then a new round may start on it`() = runTest {
            val service = service()
            val story = card()
            service.cancel(board, service.start(story).id, facilitator)

            assertEquals(RoundState.OPEN, service.start(story).state, "a new round")
        }

        @Test
        fun `when a board has 10 open rounds then the 11th is 409 PLANNING_ROUND_LIMIT_REACHED with the limit`() = runTest {
            val service = service(PlanningSettings(createsPerMinute = 100))
            repeat(10) { service.start() }

            val error = assertFailsWith<DomainException>("11th open round") { service.start() }

            assertEquals(ErrorCode.PLANNING_ROUND_LIMIT_REACHED to "10", error.errorCode to error.params["limit"], "code and limit")
        }

        @Test
        fun `when a quick round is started then it has no story card, and the audit names none`() = runTest {
            val round = service().start(storyBlockId = null)

            assertEquals(RoundState.OPEN to null, round.state to round.storyBlockId, "open, no card")
            val details = assertIs<RoundCreated>(audit.events.single().details, "audit details")
            assertNull(details.storyBlockId, "no story block in the event")
            assertEquals(listOf("started"), metrics.rounds, "metric as for any round")
        }

        @Test
        fun `when quick rounds are started then several may be open at once - one per card does not apply`() = runTest {
            val service = service()

            val first = service.start(storyBlockId = null)
            val second = service.start(storyBlockId = null)

            assertEquals(setOf(first.id, second.id), service.list(board, RoundState.OPEN, facilitator).map { it.id }.toSet(), "both open")
        }

        @Test
        fun `when quick rounds and rounds on cards together reach 10 then the 11th of either kind is 409 PLANNING_ROUND_LIMIT_REACHED`() =
            runTest {
                val service = service(PlanningSettings(createsPerMinute = 100))
                repeat(5) { service.start() }
                repeat(5) { service.start(storyBlockId = null) }

                assertEquals(ErrorCode.PLANNING_ROUND_LIMIT_REACHED,
                    assertFailsWith<DomainException>("11th, quick") { service.start(storyBlockId = null) }.errorCode, "quick round")
                assertEquals(ErrorCode.PLANNING_ROUND_LIMIT_REACHED,
                    assertFailsWith<DomainException>("11th, on a card") { service.start() }.errorCode, "round on a card")
            }

        @Test
        fun `when an eleventh round is started within a minute then 429 - ten rounds per user and minute`() = runTest {
            val service = service(PlanningSettings(maxOpenRounds = 50))
            repeat(10) { service.start() }

            assertFailsWith<RateLimitedException>("11th create") { service.start() }
            assertEquals(listOf("rate_limit"), metrics.refused, "a refusal is a metric")
            clock.advanceBy(61.seconds)
            service.start()
        }

        @Test
        fun `when the title has a control or format character then 400 VALIDATION_FAILED`() = runTest {
            val service = service()

            listOf("line\nbreak", "zero​width", "rtl‮override").forEach { title ->
                val error = assertFailsWith<DomainException>("title $title") {
                    service.create(CreateRoundCommand(board, card(), title, DeckSpec(DeckKind.TSHIRT, null), facilitator))
                }
                assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "code for a title with an invisible character")
            }
        }

        @Test
        fun `when the story block id is not a lowercase uuid then 400 VALIDATION_FAILED`() = runTest {
            val error = assertFailsWith<DomainException>("bad id") { service().start(storyBlockId = "not-a-uuid") }

            assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "code")
        }

        @Test
        fun `when a custom deck has values that are equal after NFC then 400 VALIDATION_FAILED`() = runTest {
            val error = assertFailsWith<DomainException>("two spellings of e-acute") {
                service().start(deck = DeckSpec(DeckKind.CUSTOM, listOf("é", "é")))
            }

            assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "distinct after NFC")
        }

        @Test
        fun `when a custom deck is valid then its values are kept in order`() = runTest {
            val round = service().start(deck = DeckSpec(DeckKind.CUSTOM, listOf("1", "2", "4", "8", "16", "?")))

            assertEquals(listOf("1", "2", "4", "8", "16", "?"), round.deck.values, "order is the order of the estimate")
        }

        @Test
        fun `when a custom deck breaks a rule then 400 VALIDATION_FAILED (too few, too many, too long, blank edge, control)`() = runTest {
            val service = service(PlanningSettings(createsPerMinute = 100))
            val bad = listOf(
                listOf("1"), List(21) { "v$it" }, listOf("1", "123456789"), listOf("1", " 2"), listOf("1", "2 "), listOf("1", "a\tb"),
                listOf("1", "x‍y"),
            )

            bad.forEach { values ->
                val error = assertFailsWith<DomainException>("deck $values") { service.start(deck = DeckSpec(DeckKind.CUSTOM, values)) }
                assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "code for $values")
            }
            assertFailsWith<DomainException>("custom deck without values") { service.start(deck = DeckSpec(DeckKind.CUSTOM, null)) }
        }

        @Test
        fun `when a board keeps too many closed rounds then a create prunes the oldest cancelled first`() = runTest {
            val service = service(PlanningSettings(maxClosedRounds = 3, createsPerMinute = 100))
            val revealed = mutableListOf<Uuid>()
            repeat(2) {
                val round = service.start()
                clock.advanceBy(1.minutes)
                service.reveal(board, round.id, facilitator)
                revealed += round.id
            }
            val cancelled = mutableListOf<Uuid>()
            repeat(2) {
                val round = service.start()
                clock.advanceBy(1.minutes)
                service.cancel(board, round.id, facilitator)
                cancelled += round.id
            }
            service.cast(service.start(), anna, "5") // an open round with a vote must survive

            service.start() // 4 closed: one too many

            assertEquals(setOf(cancelled[0]), (cancelled + revealed).toSet() - rounds.rows.keys,
                "the oldest CANCELLED is gone, nothing else")
            service.start(card()) // still 3 closed
            assertEquals(3, rounds.rows.values.count { it.state != RoundState.OPEN }, "closed rounds kept")
        }

        @Test
        fun `when all closed rounds are revealed then the oldest revealed ones go with their participants`() = runTest {
            val service = service(PlanningSettings(maxClosedRounds = 2, createsPerMinute = 100))
            val ids = List(3) {
                val round = service.start()
                service.cast(round, anna, "3")
                clock.advanceBy(1.minutes)
                service.reveal(board, round.id, facilitator)
                round.id
            }

            service.start()

            assertEquals(ids.drop(1).toSet(), rounds.rows.values.filter { it.state == RoundState.REVEALED }.map { it.id }.toSet(),
                "oldest revealed pruned")
            assertEquals(setOf(ids[1], ids[2]), participants.rows.values.map { it.roundId }.toSet(),
                "their participants and votes are gone")
        }
    }

    @Nested
    inner class Joining {

        @Test
        fun `when a member who may vote fetches an open round then they are listed with voted false and the version rises`() = runTest {
            val service = service()
            val round = service.start()

            val seen = service.fetch(round, anna)

            assertEquals(listOf("Anna" to false), seen.participants.map { it.displayName to it.voted }, "listed, not voted")
            assertEquals(round.version + 1, seen.version, "a join raises the version")
            assertEquals(seen.version, service.fetch(round, anna).version, "fetching again changes nothing")
        }

        @Test
        fun `when a viewer fetches an open round then they are not listed`() = runTest {
            val service = service()
            val round = service.start()

            val seen = service.fetch(round, ben, mayJoin = false)

            assertEquals(emptyList(), seen.participants, "viewers see the round without being listed")
            assertEquals(round.version, seen.version, "no join, no new version")
        }

        @Test
        fun `when a guest fetches an open round then the guest is not added - only a vote adds a guest`() = runTest {
            val service = service()
            val round = service.start()

            val seen = service.fetch(round, guest(), mayJoin = true)

            assertEquals(emptyList(), seen.participants, "getPokerRound never adds a guest")
        }

        @Test
        fun `when the round is full then getting it never fails, the caller just is not listed`() = runTest {
            val service = service(PlanningSettings(maxParticipants = 1))
            val round = service.start()
            service.fetch(round, anna)

            val seen = service.fetch(round, ben)

            assertEquals(listOf("Anna"), seen.participants.map { it.displayName }, "Ben is not added")
            assertEquals(listOf("round_full"), metrics.refused, "the refusal is a metric")
        }

        @Test
        fun `when a closed round is fetched then nobody joins it`() = runTest {
            val service = service()
            val round = service.start()
            service.reveal(board, round.id, facilitator)

            assertEquals(emptyList(), service.fetch(round, anna).participants, "a closed round never changes")
        }

        @Test
        fun `when a round of another board is fetched then 404 PLANNING_ROUND_NOT_FOUND`() = runTest {
            val service = service()
            val round = service.start()

            val error = assertFailsWith<DomainException>("other board") { service.get(GetRoundQuery(Uuid.generateV7(), round.id, anna,
                true)) }

            assertEquals(ErrorCode.PLANNING_ROUND_NOT_FOUND, error.errorCode, "code")
        }
    }

    @Nested
    inner class Voting {

        @Test
        fun `when a member votes the first time then they join and the version rises once`() = runTest {
            val service = service()
            val round = service.start()

            service.cast(round, anna, "5")

            val seen = service.fetch(round, anna)
            assertEquals(listOf("Anna" to true), seen.participants.map { it.displayName to it.voted }, "voted")
            assertEquals("5", seen.myVote, "my own vote")
            assertEquals(round.version + 1, seen.version, "join and first vote are one change")
        }

        @Test
        fun `when a member who already joined votes the first time then the version rises once more`() = runTest {
            val service = service()
            val round = service.start()
            val joined = service.fetch(round, anna)

            service.cast(round, anna, "5")

            assertEquals(joined.version + 1, service.fetch(round, anna).version, "first vote")
        }

        @Test
        fun `when a vote is changed or repeated then the version stays - nobody else may notice`() = runTest {
            val service = service()
            val round = service.start()
            service.cast(round, anna, "5")
            val before = service.fetch(round, anna).version

            service.cast(round, anna, "8")
            service.cast(round, anna, "8")

            val after = service.fetch(round, anna)
            assertEquals(before, after.version, "unchanged version")
            assertEquals("8", after.myVote, "the new value")
        }

        @Test
        fun `when another member looks at an open round then they see who voted but never a value`() = runTest {
            val service = service()
            val round = service.start()
            service.cast(round, anna, "13")

            val seen = service.fetch(round, ben)

            assertNull(seen.myVote, "Ben has not voted")
            assertNull(seen.result, "no result before the reveal")
            assertTrue(seen.participants.first { it.displayName == "Anna" }.voted, "Anna voted")
            assertEquals(listOf("Anna", "Ben").sorted(), seen.participants.map { it.displayName }.sorted(), "Ben joined by looking")
        }

        @Test
        fun `when the value is not a card of the deck then 400 PLANNING_VALUE_INVALID that does not echo the value`() = runTest {
            val service = service()
            val round = service.start()

            val error = assertFailsWith<DomainException>("not in the deck") { service.cast(round, anna, "secret-42") }

            assertEquals(ErrorCode.PLANNING_VALUE_INVALID, error.errorCode, "code")
            assertTrue(error.params.values.none { it.contains("secret-42") } && !error.message.orEmpty().contains("secret-42"),
                "value not echoed")
            assertTrue(metrics.votes == 0, "no vote counted")
        }

        @Test
        fun `when the case of a value differs then it is not a card - exact match`() = runTest {
            val service = service()
            val round = service.start(deck = DeckSpec(DeckKind.TSHIRT, null))

            assertFailsWith<DomainException>("lowercase m") { service.cast(round, anna, "m") }
        }

        @Test
        fun `when a round is revealed or cancelled then a vote is 409 PLANNING_ROUND_CLOSED`() = runTest {
            val service = service()
            val revealed = service.start()
            val cancelled = service.start()
            service.reveal(board, revealed.id, facilitator)
            service.cancel(board, cancelled.id, facilitator)

            listOf(revealed to "REVEALED", cancelled to "CANCELLED").forEach { (round, state) ->
                val error = assertFailsWith<DomainException>("vote on $state") { service.cast(round, anna, "5") }
                assertEquals(ErrorCode.PLANNING_ROUND_CLOSED to state, error.errorCode to error.params["state"], "code and state")
            }
        }

        @Test
        fun `when the round is full then a new voter is 409 PLANNING_ROUND_FULL, a participant may still change`() = runTest {
            val service = service(PlanningSettings(maxParticipants = 2, votesPerMinute = 100))
            val round = service.start()
            service.cast(round, anna, "1")
            service.cast(round, ben, "2")

            val error = assertFailsWith<DomainException>("third voter") { service.cast(round, Principal.Member(Uuid.generateV7(), "Cy"),
                "3") }
            service.cast(round, anna, "5")

            assertEquals(ErrorCode.PLANNING_ROUND_FULL to "2", error.errorCode to error.params["limit"], "code and the cap that was hit")
            assertEquals(listOf("round_full"), metrics.refused, "cap refusals are a metric")
            assertEquals("5", service.fetch(round, anna).myVote, "a participant of a full round can change the vote")
        }

        @Test
        fun `when 50 guests are in then another guest is 409 PLANNING_ROUND_FULL with limit 50`() = runTest {
            val service = service(PlanningSettings(maxGuests = 2, maxGuestsPerShare = 10, votesPerMinute = 100))
            val round = service.start()
            service.cast(round, guest("a", Uuid.random()), "1")
            service.cast(round, guest("b", Uuid.random()), "1")

            val error = assertFailsWith<DomainException>("third guest") { service.cast(round, guest("c", Uuid.random()), "1") }

            assertEquals("2", error.params["limit"], "the guest cap")
            service.cast(round, anna, "1") // members are not guests
        }

        @Test
        fun `when 20 guests of one link are in then another guest of that link is 409, one of another link is not`() = runTest {
            val service = service(PlanningSettings(maxGuestsPerShare = 2, votesPerMinute = 100))
            val round = service.start()
            service.cast(round, guest("a"), "1")
            service.cast(round, guest("b"), "1")

            val error = assertFailsWith<DomainException>("third guest of the link") { service.cast(round, guest("c"), "1") }
            service.cast(round, guest("d", Uuid.random()), "1")

            assertEquals(ErrorCode.PLANNING_ROUND_FULL to "2", error.errorCode to error.params["limit"], "the per-link cap")
        }

        @Test
        fun `when a guest votes then it is listed with guest true under its name`() = runTest {
            val service = service()
            val round = service.start()
            val gus = guest("Gus")

            service.cast(round, gus, "3")

            val seen = service.fetch(round, gus, mayJoin = false)
            assertEquals(Triple("Gus", true, true), seen.participants.single().let { Triple(it.displayName, it.guest, it.voted) },
                "guest participant")
            assertNull(seen.participants.single().userId, "a guest has no user id")
            assertEquals("3", seen.myVote, "my vote")
        }

        @Test
        fun `when one user votes more than 30 times a minute in a round then 429, and the next minute is free`() = runTest {
            val service = service()
            val round = service.start()
            repeat(30) { service.cast(round, anna, "5") }

            assertFailsWith<RateLimitedException>("31st vote") { service.cast(round, anna, "5") }
            clock.advanceBy(3.minutes)
            service.cast(round, anna, "5")
        }

        @Test
        fun `when guests of one link vote over 100 times a minute then 429 although each guest is under its own limit`() = runTest {
            val service = service()
            val round = service.start()
            val guests = List(5) { guest("g$it") }

            assertFailsWith<RateLimitedException>("101st vote of the link") {
                repeat(21) { guests.forEach { guest -> service.cast(round, guest, "5") } }
            }
        }

        @Test
        fun `when a member fetches a round more than 60 times a minute then 429`() = runTest {
            val service = service()
            val round = service.start()
            repeat(60) { service.fetch(round, anna) }

            assertFailsWith<RateLimitedException>("61st poll") { service.fetch(round, anna) }
        }
    }

    @Nested
    inner class Closing {

        @Test
        fun `when a round is revealed then votes and result are visible, and the audit counts members and guests but no vote`() = runTest {
            val service = service()
            val round = service.start()
            service.cast(round, anna, "3")
            service.cast(round, ben, "5")
            service.cast(round, guest("Gus"), "5")
            service.fetch(round, Principal.Member(Uuid.generateV7(), "Cy")) // joins without a vote

            val revealed = service.reveal(board, round.id, facilitator)

            assertEquals(RoundState.REVEALED, revealed.state, "state")
            assertEquals(listOf("Anna" to "3", "Ben" to "5", "Gus" to "5"), revealed.result?.votes?.map { it.displayName to it.value },
                "votes in joining order")
            assertEquals("5", revealed.result?.suggestion, "most chosen")
            assertTrue(revealed.revealedAt != null, "revealed at")
            val details = assertIs<RoundRevealed>(audit.events.last().details, "audit details")
            assertEquals(2 to 1, details.memberVotes to details.guestVotes, "members and guests separately")
            assertTrue(audit.events.none { it.toString().contains("\"5\"") }, "no individual vote in the audit")
            assertEquals("revealed", metrics.rounds.last(), "metric")
        }

        @Test
        fun `when a quick round gets votes of members and guests and is revealed then the result is shown as for any round`() = runTest {
            val service = service()
            val round = service.start(storyBlockId = null)
            service.cast(round, anna, "3")
            service.cast(round, guest("Gus"), "5")
            service.cast(round, ben, "5")

            val revealed = service.reveal(board, round.id, facilitator)

            assertNull(revealed.storyBlockId, "still no card")
            assertEquals("5" to 4.33, revealed.result?.suggestion to revealed.result?.average, "suggestion and average")
            val details = assertIs<RoundRevealed>(audit.events.last().details, "audit details")
            assertNull(details.storyBlockId, "no story block in the event")
            assertEquals(2 to 1, details.memberVotes to details.guestVotes, "members and guests separately")
        }

        @Test
        fun `when a quick round is cancelled then its votes are gone and the audit names no story card`() = runTest {
            val service = service()
            val round = service.start(storyBlockId = null)
            service.cast(round, anna, "8")

            val cancelled = service.cancel(board, round.id, facilitator)

            assertEquals(RoundState.CANCELLED, cancelled.state, "state")
            assertTrue(participants.rows.values.all { it.vote == null }, "the votes are gone from the store")
            assertNull(assertIs<RoundCancelled>(audit.events.last().details, "audited").storyBlockId, "no story block")
        }

        @Test
        fun `when a guest's link was revoked but the guest is still in the round then the reveal drops them and their vote`() = runTest {
            val service = service()
            val round = service.start()
            val gone = Uuid.generateV7()
            service.cast(round, anna, "3")
            service.cast(round, guest("Revoked Rita", gone), "8")
            service.cast(round, guest("Gus"), "5")
            shares.revoked += gone // removeGuestsOfShare failed after the revoke

            val revealed = service.reveal(board, round.id, facilitator)

            assertEquals(listOf("Anna", "Gus"), revealed.result?.votes?.map { it.displayName }, "the revoked guest's vote is not revealed")
            assertEquals(listOf("Anna", "Gus"), revealed.participants.map { it.displayName }, "and they are not listed")
            assertEquals(emptyList(), participants.rows.values.filter { it.shareId == gone }, "their rows are deleted")
            val details = assertIs<RoundRevealed>(audit.events.last().details, "audit details")
            assertEquals(1 to 1, details.memberVotes to details.guestVotes, "the audit counts only who counts")
            assertEquals(setOf(gone, share), shares.asked.single().toSet(), "each link was asked about once")
        }

        @Test
        fun `when no guest is in the round then the reveal does not ask for links`() = runTest {
            val service = service()
            val round = service.start()
            service.cast(round, anna, "3")

            service.reveal(board, round.id, facilitator)

            assertEquals(emptyList(), shares.asked, "members have no link")
        }

        @Test
        fun `when a round with zero votes is revealed then the result is empty`() = runTest {
            val service = service()
            val round = service.start()

            val result = checkNotNull(service.reveal(board, round.id, facilitator).result) { "result" }

            assertEquals(emptyList(), result.votes, "no votes")
            assertNull(result.average, "no average")
            assertNull(result.suggestion, "no suggestion")
        }

        @Test
        fun `when a round is revealed twice or cancelled after the reveal then 409 PLANNING_ROUND_CLOSED`() = runTest {
            val service = service()
            val round = service.start()
            service.reveal(board, round.id, facilitator)

            assertEquals(ErrorCode.PLANNING_ROUND_CLOSED, assertFailsWith<DomainException>("reveal again") { service.reveal(board,
                round.id, facilitator) }.errorCode, "reveal")
            assertEquals(ErrorCode.PLANNING_ROUND_CLOSED, assertFailsWith<DomainException>("cancel") { service.cancel(board, round.id,
                facilitator) }.errorCode, "cancel")
        }

        @Test
        fun `when a round is cancelled then its votes are deleted at once and nobody ever sees them`() = runTest {
            val service = service()
            val round = service.start()
            service.cast(round, anna, "8")

            val cancelled = service.cancel(board, round.id, facilitator)

            assertEquals(RoundState.CANCELLED, cancelled.state, "state")
            assertNull(cancelled.result, "never revealed")
            assertTrue(participants.rows.values.all { it.vote == null }, "the votes are gone from the store")
            assertNull(service.fetch(round, anna).myVote, "not even their owner")
            assertIs<RoundCancelled>(audit.events.last().details, "audited")
        }

        @Test
        fun `when a guest looks at a closed round it took part in then it sees it, otherwise 404`() = runTest {
            val service = service()
            val round = service.start()
            val gus = guest()
            service.cast(round, gus, "2")
            service.reveal(board, round.id, facilitator)

            assertEquals(RoundState.REVEALED, service.fetch(round, gus, mayJoin = false).state, "a participant")
            val error = assertFailsWith<DomainException>("a stranger") { service.fetch(round, guest("Eve"), mayJoin = false) }
            assertEquals(ErrorCode.PLANNING_ROUND_NOT_FOUND, error.errorCode, "a guest never gets the history of a board")
        }

        @Test
        fun `when rounds are listed then they are in one state, newest first, and a guest sees no closed round it was not in`() = runTest {
            val service = service(PlanningSettings(createsPerMinute = 100))
            val first = service.start()
            clock.advanceBy(1.minutes)
            val second = service.start()
            service.reveal(board, second.id, facilitator)
            clock.advanceBy(1.minutes)
            val third = service.start()

            assertEquals(listOf(third.id, first.id), service.list(board, RoundState.OPEN, anna).map { it.id }, "open, newest first")
            assertEquals(listOf(second.id), service.list(board, RoundState.REVEALED, anna).map { it.id }, "revealed")
            assertEquals(emptyList(), service.list(board, RoundState.REVEALED, guest()).map { it.id }, "a guest sees no history")
        }
    }

    @Nested
    inner class Listing {

        @Test
        fun `when open rounds are listed then at most 20 come back and participants are loaded for those only`() = runTest {
            val service = service(PlanningSettings(maxOpenRounds = 30, createsPerMinute = 100))
            repeat(25) { clock.advanceBy(1.seconds); service.cast(service.start(), anna, "3") }
            participants.loaded.clear()

            val listed = service.list(board, RoundState.OPEN, anna)

            assertEquals(20, listed.size, "the cap for OPEN")
            assertEquals(listed.map { it.id }.toSet(), participants.loaded.flatten().toSet(), "participants of the listed rounds only")
        }

        @Test
        fun `when closed rounds are listed then the cap is 50`() = runTest {
            val service = service(PlanningSettings(maxClosedRounds = 100, createsPerMinute = 100))
            repeat(55) {
                clock.advanceBy(1.seconds)
                service.cancel(board, service.start().id, facilitator)
            }

            assertEquals(50, service.list(board, RoundState.CANCELLED, anna).size, "the cap of the contract")
        }

        @Test
        fun `when a guest asks for closed rounds then participants are loaded only for the rounds it took part in`() = runTest {
            val service = service()
            val mine = service.start()
            val theirs = service.start()
            val gus = guest("Gus")
            service.cast(mine, gus, "5")
            service.cast(theirs, anna, "3")
            service.reveal(board, mine.id, facilitator)
            service.reveal(board, theirs.id, facilitator)
            participants.loaded.clear()

            val listed = service.list(board, RoundState.REVEALED, gus)

            assertEquals(listOf(mine.id), listed.map { it.id }, "a closed round only as its participant")
            assertEquals(listOf(mine.id), participants.loaded.flatten(), "the other round's participants were never read")
        }

        @Test
        fun `when a member lists closed rounds then all of them are visible`() = runTest {
            val service = service()
            val one = service.start()
            val two = service.start()
            service.reveal(board, one.id, facilitator)
            service.reveal(board, two.id, facilitator)

            assertEquals(setOf(one.id, two.id), service.list(board, RoundState.REVEALED, anna).map { it.id }.toSet(), "members see them")
        }
    }

    @Nested
    inner class Housekeeping {

        @Test
        fun `when a link is revoked then its guests leave the open rounds, the version rises, closed rounds and members stay`() = runTest {
            val service = service()
            val open = service.start()
            val closed = service.start()
            val other = guest("Other", Uuid.random())
            service.cast(open, guest("Gus"), "5")
            service.cast(open, other, "8")
            service.cast(open, anna, "3")
            service.cast(closed, guest("Gus2"), "5")
            service.reveal(board, closed.id, facilitator)
            val before = service.fetch(open, anna).version

            service.removeGuestsOfShare(share)

            val seen = service.fetch(open, anna)
            assertEquals(listOf("Other", "Anna"), seen.participants.map { it.displayName }, "guests of the revoked link are gone")
            assertEquals(before + 1, seen.version, "the version rises")
            assertEquals(1, participants.rows.values.count { it.roundId == closed.id }, "a closed round is a record")
        }

        @Test
        fun `when a link without participants is revoked then nothing changes`() = runTest {
            val service = service()
            val round = service.start()

            service.removeGuestsOfShare(Uuid.random())

            assertEquals(round.version, service.fetch(round, ben, mayJoin = false).version, "version")
        }

        @Test
        fun `when boards are purged then their rounds, participants and votes are deleted`() = runTest {
            val service = service(PlanningSettings(createsPerMinute = 100))
            val other = Uuid.generateV7()
            val doomed = service.start()
            service.cast(doomed, anna, "5")
            val kept = service.start(on = other)
            service.cast(kept, anna, "5")

            service.deleteBoardData(listOf(board))

            assertEquals(setOf(kept.id), rounds.rows.keys, "only the other board's round is left")
            assertEquals(setOf(kept.id), participants.rows.values.map { it.roundId }.toSet(), "and its participants")
        }

        @Test
        fun `when the header of a round is asked then it names the facilitator and state, another board finds nothing`() = runTest {
            val service = service()
            val round = service.start()

            assertEquals(facilitator.id, service.header(board, round.id).facilitatorId, "facilitator")
            assertEquals(ErrorCode.PLANNING_ROUND_NOT_FOUND,
                assertFailsWith<DomainException>("other board") { service.header(Uuid.generateV7(), round.id) }.errorCode, "404")
        }
    }
}
