package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemView
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.uuid.Uuid

class SessionViewsTest {

    private val anna = Principal.Member(Uuid.generateV7(), "Anna")
    private val ben = Principal.Member(Uuid.generateV7(), "Ben")
    private val cleo = Principal.Member(Uuid.generateV7(), "Cleo")
    private val gus = Principal.Guest(Uuid.random(), "Gus", Uuid.generateV7())
    private val watcher = Principal.Member(Uuid.generateV7(), "Walt")

    private fun seated(principal: Principal) = Viewer(principal, editor = false, owner = false)

    /** What a card says about itself apart from what identifies it: must be the same on every card a viewer does not hold (E3). */
    private fun ItemView.secret() = listOf(mine, column, moveCount, marked, currentValue, myEntry, result, decision, overridden)

    private class Table(val session: StoredSession, val snapshot: Snapshot)

    /** A rotation in round [round] with Anna, Ben and Cleo in slots 0, 1, 2, a watcher, and entries of every earlier round. */
    private fun rotation(round: Int, state: SessionState = SessionState.ROTATING, anonymous: Boolean = true): Table {
        val session = aSession(state = state, round = round, items = 6, anonymous = anonymous)
            .copy(moderatorId = Uuid.generateV7())
        val seats = listOf(
            aSeat(session, anna, slot = 0), aSeat(session, ben, slot = 1), aSeat(session, cleo, slot = 2),
            aSeat(session, watcher, slot = null, position = 4, seated = false),
        )
        val items = (0 until 6).map { anItem(session, it) }
        val entries = (0 until round).flatMap { r ->
            items.map { item ->
                anEntry(item, seats[Ring.holder(item.position, r, 3)], r, value = listOf("3", "5", "8")[r % 3], shuffle = r * 7L)
            }
        }
        return Table(session, Snapshot(session, seats, items, entries))
    }

    @Nested
    inner class BeforeReview {

        @Test
        fun `when somebody looks at a rotation round then no card they do not hold differs from another one (E3)`() {
            val table = rotation(round = 1)
            val moderator = Viewer(Principal.Member(table.session.moderatorId, "Mona"), editor = true, owner = false)
            val owner = Viewer(Principal.Member(Uuid.generateV7(), "Olga"), editor = true, owner = true)

            listOf(seated(anna), seated(ben), seated(watcher), moderator, owner).forEach { viewer ->
                val view = assertNotNull(SessionViews.view(table.snapshot, viewer, T0), "visible")
                val foreign = view.items.filter { !it.mine }.map { it.secret() }.toSet()
                assertEquals(1, foreign.size, "${viewer.principal.displayName}: every card not held looks the same")
                assertEquals(listOf(false, null, null, null, null, null, null, null, null), foreign.single(), "and says nothing")
            }
        }

        @Test
        fun `when the holder looks then they see the previous value of their cards only, without author or reason (E4)`() {
            val table = rotation(round = 1)

            val view = assertNotNull(SessionViews.view(table.snapshot, seated(anna), T0), "visible")

            val mine = view.items.filter { it.mine }
            assertEquals(listOf(2, 5), mine.map { it.position }, "round 1: slot 0 holds cards 2 and 5")
            assertEquals(listOf("3", "3"), mine.map { it.currentValue }, "the round-0 value")
            assertTrue(mine.all { it.myEntry == null && it.result == null }, "no entry yet, no result")
        }

        @Test
        fun `when the holder entered a value then only they see it as myEntry, and only their seat flips to done`() {
            val table = rotation(round = 1)
            val card = table.snapshot.items[2]
            val entry = anEntry(card, table.snapshot.seats[0], 1, "8", reason = "bigger")
            val snapshot = Snapshot(table.session, table.snapshot.seats, table.snapshot.items, table.snapshot.entries + entry)

            val annaView = assertNotNull(SessionViews.view(snapshot, seated(anna), T0), "anna")
            val benView = assertNotNull(SessionViews.view(snapshot, seated(ben), T0), "ben")
            val benBefore = assertNotNull(SessionViews.view(table.snapshot, seated(ben), T0), "ben before")

            assertEquals(EntryView("8", "bigger", false), annaView.items[2].myEntry, "Anna sees her entry")
            assertEquals(benBefore.items, benView.items, "Ben sees no difference on any card")
            assertEquals(listOf(false, false, false, false), benView.seats.map { it.done }, "Anna still holds card 5, so nobody is done")
        }

        @Test
        fun `when magic is placing then a column is shown on the caller's own cards only, and no mark or count`() {
            val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.PLACING, items = 4)
            val seats = listOf(aSeat(session, anna, 0), aSeat(session, ben, 1))
            val items = listOf(anItem(session, 0, "3"), anItem(session, 1, "5"), anItem(session, 2), anItem(session, 3, "8"))

            val view = assertNotNull(SessionViews.view(Snapshot(session, seats, items), seated(anna), T0), "anna")

            assertEquals(listOf("3", null, null, null), view.items.map { it.column }, "Anna's cards are 0 and 2; Ben's columns are hidden")
            assertTrue(view.items.all { it.moveCount == null && it.marked == null }, "no counts or marks while placing")
            assertEquals(listOf(false, true), view.seats.map { it.done }, "Ben placed both of his, Anna not yet")
        }

        @Test
        fun `when magic is moving then everybody sees columns, counts and marks of every card, and nobody has own cards`() {
            val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.MOVING, items = 2)
            val seats = listOf(aSeat(session, anna, 0), aSeat(session, ben, 1))
            val items = listOf(anItem(session, 0, "3").copy(moveCount = 2), anItem(session, 1, "?", marked = true))

            val view = assertNotNull(SessionViews.view(Snapshot(session, seats, items), seated(watcher), T0), "a watcher")

            assertEquals(listOf("3", "?"), view.items.map { it.column }, "columns")
            assertEquals(listOf(2 to false, 0 to true), view.items.map { it.moveCount to it.marked }, "counts and marks")
            assertTrue(view.items.none { it.mine }, "nothing is anybody's in MOVING")
        }
    }

    @Nested
    inner class Review {

        @Test
        fun `when the session is in REVIEW then everyone sees the same results and nobody holds anything`() {
            val table = rotation(round = 2, state = SessionState.REVIEW)

            val annaView = assertNotNull(SessionViews.view(table.snapshot, seated(anna), T0), "anna")
            val watcherView = assertNotNull(SessionViews.view(table.snapshot, seated(watcher), T0), "watcher")

            assertEquals(annaView.items.map { it.result }, watcherView.items.map { it.result }, "the same results")
            assertTrue(annaView.items.all { !it.mine && it.currentValue == null && it.myEntry == null }, "no own cards any more")
            assertEquals(2, annaView.items.first().result?.entries?.size, "two rounds of entries per card")
        }

        @Test
        fun `when a cancelled session is shown then no card has a result, decision, column, count or mark`() {
            val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.CANCELLED)
            val items = listOf(anItem(session, 0, "3").copy(decision = "3"))

            val view = assertNotNull(SessionViews.view(Snapshot(session, emptyList(), items), seated(anna), T0), "visible to a member")

            assertEquals(listOf(null, null, null, null, null), view.items.single().let {
                listOf(it.result, it.decision, it.column, it.moveCount, it.marked)
            }, "nothing")
        }

        @Test
        fun `when 30 days after DONE have passed then the answer holds no single value any more`() {
            val table = rotation(round = 2, state = SessionState.DONE)
            val closed = Snapshot(table.session.copy(closedAt = T0), table.snapshot.seats, table.snapshot.items, table.snapshot.entries)

            val early = assertNotNull(SessionViews.view(closed, seated(anna), T0 + 29.days), "29 days")
            val late = assertNotNull(SessionViews.view(closed, seated(anna), T0 + 30.days), "30 days")

            assertEquals(2, early.items.first().result?.entries?.size, "still there")
            assertEquals(0, late.items.first().result?.entries?.size, "gone")
            assertEquals(early.items.first().result?.average, late.items.first().result?.average, "the mean stays")
        }
    }

    @Nested
    inner class Guests {

        @Test
        fun `when a guest without a seat looks at REVIEW, DONE or CANCELLED then there is nothing to see (E9)`() {
            val table = rotation(round = 2, state = SessionState.REVIEW)

            assertNull(SessionViews.view(table.snapshot, seated(gus), T0), "review")
            assertNull(SessionViews.summary(table.session.copy(state = SessionState.DONE), table.snapshot.seats, seated(gus)), "done")
            assertNotNull(
                SessionViews.summary(table.session.copy(state = SessionState.ROTATING), table.snapshot.seats, seated(gus)),
                "running",
            )
        }

        @Test
        fun `when a guest holds a seat then it sees REVIEW, but not after the seat was removed`() {
            val table = rotation(round = 2, state = SessionState.REVIEW)
            val seat = aSeat(table.session, gus, slot = null, position = 9)
            val with = Snapshot(table.session, table.snapshot.seats + seat, table.snapshot.items, table.snapshot.entries)
            val removed = Snapshot(
                table.session,
                table.snapshot.seats + seat.copy(removed = true),
                table.snapshot.items,
                table.snapshot.entries,
            )

            assertNotNull(SessionViews.view(with, seated(gus), T0), "seated guest")
            assertNull(SessionViews.view(removed, seated(gus), T0), "removed seat")
        }
    }

    @Nested
    inner class Me {

        @Test
        fun `when the moderator and a seat look then me says whose seat and who moderates, removed seats are not listed`() {
            val table = rotation(round = 0)
            val removed = table.snapshot.seats[1].copy(removed = true)
            val seats = listOf(table.snapshot.seats[0], removed, table.snapshot.seats[2], table.snapshot.seats[3])
            val snapshot = Snapshot(table.session, seats, table.snapshot.items, table.snapshot.entries)
            val moderator = Viewer(Principal.Member(table.session.moderatorId, "Mona"), editor = true, owner = false)
            val formerModerator = Viewer(Principal.Member(table.session.moderatorId, "Mona"), editor = false, owner = false)

            val annaView = assertNotNull(SessionViews.view(snapshot, seated(anna), T0), "anna")
            val modView = assertNotNull(SessionViews.view(snapshot, moderator, T0), "moderator")

            assertEquals(table.snapshot.seats[0].id to true, annaView.me.seatId to annaView.me.seated, "Anna's own seat, taking part")
            assertFalse(annaView.me.moderator, "Anna does not moderate")
            assertTrue(modView.me.moderator && modView.me.seatId == null, "the moderator moderates without a seat")
            assertFalse(assertNotNull(SessionViews.view(snapshot, formerModerator, T0), "former").me.moderator, "not after losing EDITOR")
            assertEquals(listOf("Anna", "Cleo", "Walt"), annaView.seats.map { it.displayName }, "Ben was removed")
            assertEquals(listOf(true, true, false), annaView.seats.map { it.seated }, "the watcher does not take part")
        }
    }
}
