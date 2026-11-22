package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.DecisionOverridden
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.provides.AdvanceCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.DecideCommand
import at.dergeorg.drawboard.planning.domain.sessions.provides.PlaceCommand
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class MagicPlayTest {

    private val world = EstimationWorld()

    private suspend fun place(session: SessionView, who: Principal, itemId: Uuid, value: String?, state: SessionState? = null) =
        world.play.place(PlaceCommand(world.board, session.id, itemId, who, value, state))

    private suspend fun failure(block: suspend () -> Unit): DomainException = assertFailsWith<DomainException>("refused") { block() }

    private suspend fun placing(items: Int = 4): SessionView =
        world.started(world.create(mode = EstimationMode.MAGIC, items = items), world.anna, world.ben)

    /** Every card placed in 5, then MOVING. */
    private suspend fun moving(items: Int = 4): SessionView {
        val session = placing(items)
        listOf(world.anna, world.ben).forEach { who -> world.mine(session, who).forEach { place(session, who, it.id, "5") } }
        world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.PLACING, 0))
        return world.look(session, world.moderatorView)
    }

    @Nested
    inner class Placing {

        @Test
        fun `when a seat places its own cards then nobody else sees the columns and the version rises only when done flips (E3, E4)`() =
            runTest {
                val session = placing()
                val own = world.mine(session, world.anna)
                val start = world.stored(session).version

                place(session, world.anna, own[0].id, "3")
                val afterOne = world.stored(session).version
                place(session, world.anna, own[1].id, "?")

                assertEquals(start, afterOne, "one of two cards: nothing to notice")
                assertEquals(start + 1, world.stored(session).version, "done flipped")
                assertEquals(
                    listOf(null, null, null, null),
                    world.look(session, world.viewer(world.ben)).items.map { it.column },
                    "Ben sees none",
                )
                assertEquals(
                    listOf(null, null, null, null),
                    world.look(session, world.moderatorView).items.map { it.column },
                    "nor the moderator",
                )
                assertEquals(
                    listOf("3", "?"),
                    world.look(session, world.viewer(world.anna)).items.filter { it.mine }.map { it.column },
                    "Anna",
                )
            }

        @Test
        fun `when a seat takes an own card out with null then it has no column and the seat is not done any more`() = runTest {
            val session = placing(items = 2)
            val own = world.mine(session, world.anna).single()
            place(session, world.anna, own.id, "3")

            place(session, world.anna, own.id, null)

            assertNull(world.items.rows.getValue(own.id).column, "out")
            assertEquals(listOf(false, false), world.look(session, world.moderatorView).seats.map { it.done }, "not done")
        }

        @Test
        fun `when a seat places another seat's card then 409 PLANNING_ITEM_NOT_HELD, also with an invalid value (C2)`() = runTest {
            val session = placing()

            world.notMine(session, world.anna).forEach { card ->
                assertEquals(ErrorCode.PLANNING_ITEM_NOT_HELD, failure { place(session, world.anna, card.id, "coffee") }.errorCode, "card")
            }
        }

        @Test
        fun `when the value is coffee or no deck value then 400 PLANNING_VALUE_INVALID without the value`() = runTest {
            val session = placing()
            val own = world.mine(session, world.anna).first()

            val coffee = failure { place(session, world.anna, own.id, "coffee") }
            val unknown = failure { place(session, world.anna, own.id, "4") }

            assertEquals(
                ErrorCode.PLANNING_VALUE_INVALID to ErrorCode.PLANNING_VALUE_INVALID,
                coffee.errorCode to unknown.errorCode,
                "both",
            )
            assertTrue(unknown.params.values.none { it == "4" }, "not echoed")
        }

        @Test
        fun `when PLACING ended then a placement that expects PLACING is refused, it never lands in MOVING`() = runTest {
            val session = placing()
            val own = world.mine(session, world.anna).first()
            world.clock.advanceBy(60.seconds)

            val refused = failure { place(session, world.anna, own.id, "3", state = SessionState.PLACING) }

            assertEquals(ErrorCode.PLANNING_SESSION_WRONG_STATE, refused.errorCode, "late")
            assertEquals("MOVING", refused.params["state"], "the current state")
        }

        @Test
        fun `when a rotation session gets a placement then 409 WRONG_STATE`() = runTest {
            val session = world.started(world.create(items = 2), world.anna, world.ben)

            val refused = failure { place(session, world.anna, session.items[0].id, "3") }

            assertEquals(ErrorCode.PLANNING_SESSION_WRONG_STATE, refused.errorCode, "not a magic session")
        }
    }

    @Nested
    inner class Moving {

        @Test
        fun `when a seat moves any card then it is recorded without the mover, counted, and the version rises with every move`() =
            runTest {
                val session = moving()
                val foreign = world.notMine(session, world.anna).first().id.let { id -> world.items.rows.getValue(id) }
                val before = world.stored(session).version

                place(session, world.anna, foreign.id, "8")

                val view = world.look(session, world.viewer(world.ben)).items.single { it.id == foreign.id }
                assertEquals(Triple("8", 1, false), Triple(view.column, view.moveCount, view.marked), "column, count, not marked")
                assertEquals(before + 1, world.stored(session).version, "every move raises the version")
                assertEquals(listOf("move"), world.metrics.inputs.filter { it == "move" }, "metric without a value")
            }

        @Test
        fun `when a seat moves a card again within 10 seconds then the moves merge - back to the start removes the move`() = runTest {
            val session = moving()
            val card = world.items.findBySession(session.id).first()

            place(session, world.anna, card.id, "8")
            world.clock.advanceBy(5.seconds)
            place(session, world.anna, card.id, "13")
            val merged = world.moves.findByItem(card.id)
            world.clock.advanceBy(1.seconds)
            place(session, world.anna, card.id, "5")

            assertEquals(listOf("5" to "13"), merged.map { it.fromValue to it.toValue }, "one move 5 -> 13")
            assertTrue(world.moves.findByItem(card.id).isEmpty(), "back where it came from: no move")
            assertEquals(0, world.items.rows.getValue(card.id).moveCount, "count 0")
        }

        @Test
        fun `when two seats move a card often enough then it is marked - one seat alone never marks it`() = runTest {
            val session = moving()
            val card = world.items.findBySession(session.id).first()

            listOf("8", "3", "8").forEach { value ->
                place(session, world.anna, card.id, value)
                world.clock.advanceBy(11.seconds)
            }
            val alone = world.items.rows.getValue(card.id).marked
            place(session, world.ben, card.id, "13")

            assertEquals(false, alone, "three moves of one seat count two")
            assertEquals(true, world.items.rows.getValue(card.id).marked, "2 + 1 >= 3")
        }

        @Test
        fun `when a seat moved a card five times then the sixth is 409 PLANNING_MOVE_LIMIT_REACHED, after an invalid value check`() =
            runTest {
                val session = moving()
                val card = world.items.findBySession(session.id).first()
                listOf("8", "3", "8", "3", "8").forEach { value ->
                    place(session, world.anna, card.id, value)
                    world.clock.advanceBy(11.seconds)
                }

                val limit = failure { place(session, world.anna, card.id, "13") }
                val value = failure { place(session, world.anna, card.id, "coffee") }

                assertEquals(ErrorCode.PLANNING_MOVE_LIMIT_REACHED to "5", limit.errorCode to limit.params["limit"], "per card")
                assertEquals(ErrorCode.PLANNING_VALUE_INVALID, value.errorCode, "the value is checked before the limits")
                assertEquals(listOf("move_limit"), world.metrics.refused, "metric")
            }

        @Test
        fun `when null is sent in MOVING then 400 PLANNING_VALUE_INVALID`() = runTest {
            val session = moving()

            val refused = failure { place(session, world.anna, session.items[0].id, null) }

            assertEquals(ErrorCode.PLANNING_VALUE_INVALID, refused.errorCode, "null only in PLACING")
        }

        @Test
        fun `when MOVING ends then the marks freeze and the moves lose their seats, and REVIEW shows the trail`() = runTest {
            val session = moving()
            val card = world.items.findBySession(session.id).first()
            place(session, world.anna, card.id, "8")

            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.MOVING, 0))
            val review = world.look(session, world.viewer(world.ben))

            assertTrue(world.moves.rows.values.all { it.seatId == null }, "no mover kept (E4)")
            assertEquals(listOf("5", "8"), review.items.single { it.id == card.id }.result?.moveTrail, "trail")
            assertEquals(listOf("8"), review.items.single { it.id == card.id }.result?.candidates, "the column of an unmarked card")
        }
    }

    @Nested
    inner class Deciding {

        private suspend fun reviewed(): SessionView {
            val session = moving(items = 2)
            val parked = world.items.findBySession(session.id).last()
            place(session, world.anna, parked.id, "?")
            world.service.advance(AdvanceCommand(world.board, session.id, world.moderatorView, SessionState.MOVING, 0))
            return session
        }

        @Test
        fun `when the moderator decides an unmarked card away from its column then it is overridden and audited (E13)`() = runTest {
            val session = reviewed()
            val card = world.items.findBySession(session.id).first()

            world.play.decide(DecideCommand(world.board, session.id, card.id, world.moderator, "13"))

            assertTrue(world.items.rows.getValue(card.id).overridden, "overridden")
            assertEquals(card.id.toString(), assertIs<DecisionOverridden>(world.audit.events.last().details, "audit").itemId, "the card")
        }

        @Test
        fun `when the moderator decides a marked card then it is never overridden, and coffee is no decision`() = runTest {
            val session = reviewed()
            val parked = world.items.findBySession(session.id).last()

            world.play.decide(DecideCommand(world.board, session.id, parked.id, world.moderator, "21"))
            val coffee = failure { world.play.decide(DecideCommand(world.board, session.id, parked.id, world.moderator, "coffee")) }

            assertEquals("21" to false, world.items.rows.getValue(parked.id)
                .let { it.decision to it.overridden }, "decided, not overridden")
            assertEquals(ErrorCode.PLANNING_DECISION_INVALID, coffee.errorCode, "coffee")
        }
    }
}
