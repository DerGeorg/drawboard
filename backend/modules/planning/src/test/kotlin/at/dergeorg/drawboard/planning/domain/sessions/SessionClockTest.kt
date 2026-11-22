package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

class SessionClockTest {

    @Nested
    inner class Deadlines {

        @Test
        fun `when the deadline has not passed then nothing is due - at the very deadline it is, no grace (E14)`() {
            val session = aSession(state = SessionState.ROTATING, phaseEndsAt = T0 + 60.seconds)

            assertFalse(SessionClock.due(session, T0 + 60.seconds - 1.milliseconds), "one millisecond before")
            assertTrue(SessionClock.due(session, T0 + 60.seconds), "at the deadline")
        }

        @Test
        fun `when a rotation round ends then the next round starts at the old deadline, not at the request`() {
            val session = aSession(state = SessionState.ROTATING, round = 0, phaseEndsAt = T0 + 60.seconds)

            val settled = SessionClock.settle(session, T0 + 70.seconds)

            assertEquals(listOf(SessionState.ROTATING), settled.entered, "one step")
            assertEquals(1, settled.session.round, "round 1")
            assertEquals(T0 + 120.seconds, settled.session.phaseEndsAt, "the next deadline counts from the old one")
            assertEquals(session.version + 1, settled.session.version, "the version rises")
        }

        @Test
        fun `when a request comes long after several deadlines then every due round is applied and the last ends in REVIEW`() {
            val session = aSession(state = SessionState.ROTATING, round = 0, phaseEndsAt = T0 + 60.seconds)

            val settled = SessionClock.settle(session, T0 + 1.hours)

            assertEquals(
                listOf(SessionState.ROTATING, SessionState.ROTATING, SessionState.REVIEW),
                settled.entered,
                "three rounds, then REVIEW",
            )
            assertEquals(2, settled.session.round, "REVIEW keeps the index of the last round")
            assertNull(settled.session.phaseEndsAt, "no deadline in REVIEW")
            assertEquals(T0 + 180.seconds, settled.session.lastActivityAt, "REVIEW started at the last deadline")
        }

        @Test
        fun `when magic placing ends then moving ends after its own time, then REVIEW`() {
            val session = aSession(mode = EstimationMode.MAGIC, state = SessionState.PLACING, phaseEndsAt = T0 + 60.seconds)

            val moving = SessionClock.settle(session, T0 + 61.seconds).session
            val review = SessionClock.settle(moving, T0 + 181.seconds).session

            assertEquals(SessionState.MOVING to T0 + 180.seconds, moving.state to moving.phaseEndsAt, "moving for 120 s from the deadline")
            assertEquals(SessionState.REVIEW, review.state, "then REVIEW")
        }

        @Test
        fun `when nothing is due then settle changes nothing`() {
            val session = aSession(state = SessionState.ROTATING, phaseEndsAt = T0 + 60.seconds)

            val settled = SessionClock.settle(session, T0)

            assertEquals(session, settled.session, "unchanged")
            assertFalse(settled.changed, "no transition")
        }

        @Test
        fun `when advancing early then the next phase counts from now`() {
            val session = aSession(state = SessionState.ROTATING, round = 0, phaseEndsAt = T0 + 60.seconds)

            val next = SessionClock.next(session, T0 + 10.seconds)

            assertEquals(1 to T0 + 70.seconds, next.round to next.phaseEndsAt, "round 1 ends 60 s after the advance")
        }

        @Test
        fun `when a session starts then magic places and rotation rotates in round 0`() {
            val magic = SessionClock.started(aSession(mode = EstimationMode.MAGIC), T0)
            val rotation = SessionClock.started(aSession(mode = EstimationMode.ROTATION), T0)

            assertEquals(SessionState.PLACING to T0 + 60.seconds, magic.state to magic.phaseEndsAt, "magic")
            assertEquals(
                Triple(SessionState.ROTATING, 0, T0 + 60.seconds),
                Triple(rotation.state, rotation.round, rotation.phaseEndsAt),
                "rotation",
            )
            assertEquals(T0, rotation.startedAt, "started at")
        }
    }

    @Nested
    inner class Idle {

        @Test
        fun `when a lobby has been idle for 24 hours then it is cancelled, a minute earlier it is not (E22)`() {
            val session = aSession(state = SessionState.LOBBY, lastActivityAt = T0)

            val before = SessionClock.settle(session, T0 + 24.hours - 1.seconds)
            val after = SessionClock.settle(session, T0 + 24.hours)

            assertFalse(before.changed, "still in the lobby")
            assertEquals(SessionState.CANCELLED, after.session.state, "cancelled")
            assertTrue(after.idleCancelled, "for idleness")
            assertEquals(T0 + 24.hours, after.session.closedAt, "closed at the request")
        }

        @Test
        fun `when a review has been idle for a day then it stays, after seven days it is cancelled`() {
            val session = aSession(state = SessionState.REVIEW, lastActivityAt = T0)

            assertFalse(SessionClock.due(session, T0 + 6.days), "six days")
            assertEquals(SessionState.CANCELLED, SessionClock.settle(session, T0 + 7.days).session.state, "seven days")
        }

        @Test
        fun `when DONE and CANCELLED sessions get old then nothing happens to them`() {
            assertFalse(SessionClock.due(aSession(state = SessionState.DONE, lastActivityAt = T0), T0 + 365.days), "done")
            assertFalse(SessionClock.due(aSession(state = SessionState.CANCELLED, lastActivityAt = T0), T0 + 365.days), "cancelled")
        }
    }
}
