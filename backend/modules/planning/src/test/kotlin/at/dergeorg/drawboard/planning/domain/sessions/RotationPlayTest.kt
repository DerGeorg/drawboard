package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.DecisionOverridden
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.provides.AdvanceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.DecideCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimateCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.StartCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class RotationPlayTest {

    private val world = EstimationWorld()

    private suspend fun estimate(
        session: SessionView,
        who: Principal,
        itemId: Uuid,
        value: String,
        reason: String? = null,
        round: Int? = null,
    ) =
        world.play.estimate(EstimateCommand(world.board, session.id, itemId, who, value, reason, round))

    private suspend fun failure(block: suspend () -> Unit): DomainException = assertFailsWith<DomainException>("refused") { block() }

    /** Three seats, three cards, two rounds; round 0 entered by everybody (Anna 3, Ben 5, Cleo 8 on their cards), now in round 1. */
    private suspend fun inRound1(advanceWhenDone: Boolean = false): SessionView {
        val session = world.started(
            world.create(items = 3, settings = world.rotationSettings(rounds = 2, advanceWhenDone = advanceWhenDone)),
            world.anna, world.ben, world.cleo,
        )
        mapOf(world.anna to "3", world.ben to "5", world.cleo to "8").forEach { (who, value) ->
            world.mine(session, who).forEach { estimate(session, who, it.id, value) }
        }
        world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 0))
        return world.look(session, world.moderatorView)
    }

    @Nested
    inner class OrderOfRefusals {

        @Test
        fun `when a seat changes a card it does not hold without a reason then it is NOT_HELD, never REASON_REQUIRED (C2, E4)`() = runTest {
            val session = inRound1()

            world.notMine(session, world.anna).forEach { card ->
                val refused = failure { estimate(session, world.anna, card.id, "21") }
                assertEquals(ErrorCode.PLANNING_ITEM_NOT_HELD, refused.errorCode, "card ${card.position}: nothing about its value")
                assertEquals(mapOf("sessionId" to session.id.toString(), "itemId" to card.id.toString()), refused.params, "one body")
            }
        }

        @Test
        fun `when a seat names a card it held in round 0 then the body is the same as for another seat's card (E2)`() = runTest {
            val session = inRound1()
            val heldBefore = world.items.findBySession(session.id).first { Ring.holder(it.position, 0, 3) == world.seatOf(
                session,
                world.anna,
            ).slot }

            val refused = failure { estimate(session, world.anna, heldBefore.id, "21") }

            assertEquals(ErrorCode.PLANNING_ITEM_NOT_HELD, refused.errorCode, "same code")
            assertEquals(setOf("sessionId", "itemId"), refused.params.keys, "same params")
        }

        @Test
        fun `when a watcher estimates then 403 PLANNING_NOT_SEATED comes before the state, the card and the value`() = runTest {
            val session = world.create(items = 3)
            listOf(world.anna, world.ben, world.cleo).forEach { world.service.join(world.board, session.id, it) }
            val two = world.seats.findBySession(session.id).take(2).map { it.id }.toSet()
            world.service.start(StartCommand(world.board, session.id, world.moderatorView, two))

            val refused = failure { estimate(session, world.cleo, session.items[0].id, "not-in-deck", round = 7) }

            assertEquals(ErrorCode.PLANNING_NOT_SEATED, refused.errorCode, "the watcher learns nothing else")
        }

        @Test
        fun `when the round in the body is not the current one then 409 WRONG_STATE before the card is looked at`() = runTest {
            val session = inRound1()
            val foreign = world.notMine(session, world.anna).first()

            val refused = failure { estimate(session, world.anna, foreign.id, "21", round = 0) }

            assertEquals(ErrorCode.PLANNING_SESSION_WRONG_STATE, refused.errorCode, "state and round first")
        }

        @Test
        fun `when the holder sends a value of no deck and no reason then 400 VALUE_INVALID comes before REASON_REQUIRED`() = runTest {
            val session = inRound1()
            val own = world.mine(session, world.anna).first()

            val refused = failure { estimate(session, world.anna, own.id, "4") }

            assertEquals(ErrorCode.PLANNING_VALUE_INVALID, refused.errorCode, "value before reason")
            assertTrue("4" !in refused.message.orEmpty() && "4" !in refused.params.values, "the value is not echoed")
        }

        @Test
        fun `when a card is not one of the session then 404 with its id`() = runTest {
            val session = inRound1()
            val unknown = Uuid.generateV7()

            val refused = failure { estimate(session, world.anna, unknown, "5") }

            assertEquals(ErrorCode.PLANNING_SESSION_NOT_FOUND, refused.errorCode, "404")
            assertEquals(unknown.toString(), refused.params["itemId"], "the item id is named")
        }

        @Test
        fun `when a reason has a line break then 400 VALIDATION_FAILED whatever the session says - it does not depend on it`() = runTest {
            val session = inRound1()

            assertFailsWith<ValidationFailedException>("form first") {
                estimate(session, world.anna, world.notMine(session, world.anna).first().id, "21", reason = "a\nb")
            }
        }
    }

    @Nested
    inner class Entering {

        @Test
        fun `when a card has no previous value then the first holder needs no reason and its reason is not kept (E6)`() = runTest {
            val session = world.started(world.create(items = 2), world.anna, world.ben)
            val own = world.mine(session, world.anna).single()

            val entry = estimate(session, world.anna, own.id, "coffee", reason = "first")

            assertEquals(EntryView("coffee", null, false), entry, "coffee is a value in rotation, no reason on a first entry")
        }

        @Test
        fun `when the holder keeps the previous value then it is kept and the reason is discarded`() = runTest {
            val session = inRound1()
            val own = world.mine(session, world.anna).single()
            val current = world.look(session, world.viewer(world.anna)).items.single { it.mine }.currentValue

            val entry = estimate(session, world.anna, own.id, checkNotNull(current), reason = "anything")

            assertEquals(EntryView(current, null, true), entry, "kept")
        }

        @Test
        fun `when the holder changes the value then a reason is required, it is stored and the own entry may change`() = runTest {
            val session = inRound1()
            val own = world.mine(session, world.anna).single()

            val refused = failure { estimate(session, world.anna, own.id, "21") }
            estimate(session, world.anna, own.id, "21", reason = " too big ")
            val changed = estimate(session, world.anna, own.id, "13", reason = "smaller")

            assertEquals(ErrorCode.PLANNING_REASON_REQUIRED, refused.errorCode, "reason required")
            assertEquals(EntryView("13", "smaller", false), changed, "own entry changed within the round")
            assertEquals(1, world.entries.rows.values.count { it.itemId == own.id && it.round == 1 }, "one entry per card and round")
        }

        @Test
        fun `when entries are made then the version rises only when the seat's done flips, not for a change (E3)`() = runTest {
            val session = world.started(world.create(items = 4), world.anna, world.ben)
            val cards = world.mine(session, world.anna)
            val start = world.stored(session).version

            estimate(session, world.anna, cards[0].id, "3")
            val afterFirst = world.stored(session).version
            estimate(session, world.anna, cards[1].id, "5")
            val afterDone = world.stored(session).version
            estimate(session, world.anna, cards[1].id, "8")

            assertEquals(start, afterFirst, "the first of two cards flips nothing")
            assertEquals(start + 1, afterDone, "done flipped")
            assertEquals(afterDone, world.stored(session).version, "changing an own entry raises nothing")
            assertEquals(listOf(true, false), world.look(session, world.viewer(world.ben)).seats.map { it.done }, "Anna is done")
        }

        @Test
        fun `when the deadline passed then an entry is 409 - no grace (E14)`() = runTest {
            val session = world.started(world.create(items = 2), world.anna, world.ben)
            val own = world.mine(session, world.anna).single()
            world.clock.advanceBy(60.seconds)

            val refused = failure { estimate(session, world.anna, own.id, "5", round = 0) }

            assertEquals(ErrorCode.PLANNING_SESSION_WRONG_STATE, refused.errorCode, "late")
            assertEquals("1", refused.params["round"], "round 1 by now")
        }

        @Test
        fun `when every holder is done and advanceWhenDone is on then the round ends at once`() = runTest {
            val session = world.started(
                world.create(items = 2, settings = world.rotationSettings(advanceWhenDone = true)),
                world.anna,
                world.ben,
            )

            estimate(session, world.anna, world.mine(session, world.anna).single().id, "3")
            estimate(session, world.ben, world.mine(session, world.ben).single().id, "5")

            assertEquals(1, world.stored(session).round, "round 1")
        }

        @Test
        fun `when the revoked seat was the last one not done then the round ends at once with advanceWhenDone (E11)`() = runTest {
            val gus = world.guest()
            val session = world.started(world.create(items = 2, settings = world.rotationSettings(advanceWhenDone = true)), world.anna, gus)
            estimate(session, world.anna, world.mine(session, world.anna).single().id, "5")

            world.service.removeGuestsOfShare(world.share)

            assertEquals(1, world.stored(session).round, "the round did not wait for the removed seat")
        }

        @Test
        fun `when the last round is complete then REVIEW shows every value and reason, shuffled, without names`() = runTest {
            val session = inRound1()
            mapOf(world.anna to "13", world.ben to "5", world.cleo to "8").forEach { (who, value) ->
                world.mine(session, who).forEach { estimate(session, who, it.id, value, reason = "r") }
            }
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.ROTATING, 1))

            val review = world.look(session, world.viewer(world.anna))

            assertEquals(SessionState.REVIEW, review.state, "review")
            assertTrue(review.items.all { it.result?.entries?.size == 2 }, "two entries per card")
            assertTrue(review.items.flatMap { it.result?.entries.orEmpty() }.all { it.displayName == null }, "anonymous")
        }
    }

    @Nested
    inner class Deciding {

        /** Anna's cards of round 0 (entered with 5), known before REVIEW drops the ring. */
        private var annaCards = emptyList<Uuid>()

        private suspend fun reviewed(): SessionView {
            val session = world.started(world.create(items = 3), world.anna, world.ben)
            annaCards = world.mine(session, world.anna).map { it.id }
            annaCards.forEach { estimate(session, world.anna, it, "5") }
            world.clock.advanceBy(1.hours)
            world.look(session, world.moderatorView)
            return session
        }

        @Test
        fun `when the moderator decides an entered value then it is stored, not overridden, and the version rises`() = runTest {
            val session = reviewed()
            val card = world.items.rows.getValue(annaCards.first())
            val before = world.stored(session).version

            world.play.decide(DecideCommand(world.board, session.id, card.id, world.moderator, "5"))

            assertEquals("5" to false, world.items.rows.getValue(card.id).let { it.decision to it.overridden }, "decided")
            assertEquals(before + 1, world.stored(session).version, "version")
        }

        @Test
        fun `when the moderator decides a value nobody entered then 400 PLANNING_DECISION_INVALID without the value`() = runTest {
            val session = reviewed()
            val card = world.items.findBySession(session.id).first { world.entries.rows.values.any { e -> e.itemId == it.id } }

            val refused = failure { world.play.decide(DecideCommand(world.board, session.id, card.id, world.moderator, "21")) }

            assertEquals(ErrorCode.PLANNING_DECISION_INVALID, refused.errorCode, "only entered values")
            assertTrue("21" !in refused.params.values, "not echoed")
        }

        @Test
        fun `when a card has no entry then any deck value may be decided, overridden and audited without the value (E13, E23)`() = runTest {
            val session = reviewed()
            val empty = world.items.findBySession(session.id).first { world.entries.rows.values.none { e -> e.itemId == it.id } }

            world.play.decide(DecideCommand(world.board, session.id, empty.id, world.moderator, "13"))

            assertTrue(world.items.rows.getValue(empty.id).overridden, "overridden")
            val details = assertIs<DecisionOverridden>(world.audit.events.last().details, "audited")
            assertEquals(empty.id.toString(), details.itemId, "the card, never the value")
        }

        @Test
        fun `when the session is not in REVIEW then deciding is 409`() = runTest {
            val session = world.started(world.create(items = 2), world.anna, world.ben)

            val refused = failure { world.play.decide(DecideCommand(world.board, session.id, session.items[0].id, world.moderator, "5")) }

            assertEquals(ErrorCode.PLANNING_SESSION_WRONG_STATE, refused.errorCode, "running")
        }
    }
}
