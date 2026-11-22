package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

/** What [SessionClock.settle] did: the session afterwards, the states it entered in order, and whether it was cancelled for idleness. */
internal data class Settlement(val session: StoredSession, val entered: List<SessionState>, val idleCancelled: Boolean) {
    val changed: Boolean get() = entered.isNotEmpty()
}

/**
 * The server clock of a session (E14, E15, E22) - pure, no scheduler: the next request after a deadline applies every transition that
 * is due. Each next deadline counts from the previous deadline, not from the request, so a late request changes nothing (no grace).
 * A session without activity for [IDLE] in LOBBY or a running phase, or for [REVIEW_IDLE] in REVIEW, is cancelled. The service calls
 * [settle] again under the session lock, so thirty clients polling at the deadline cause one transition.
 */
internal object SessionClock {

    val IDLE: Duration = 24.hours
    val REVIEW_IDLE: Duration = 7.days

    /** At most the rounds of a Rotation plus REVIEW and an idle cancel: a guard, never reached by a valid session. */
    private const val MAX_STEPS = 13

    /** Whether a request at [now] has to change [session] - read without a lock, settled with one. */
    fun due(session: StoredSession, now: Instant): Boolean = deadlinePassed(session, now) || idleSince(session)?.let { it <= now } == true

    /** Applies every transition due at [now]: the deadlines first, then the idle cancel. */
    fun settle(session: StoredSession, now: Instant): Settlement {
        var current = session
        val entered = mutableListOf<SessionState>()
        var steps = 0
        while (deadlinePassed(current, now) && steps < MAX_STEPS) {
            current = next(current, checkNotNull(current.phaseEndsAt))
            entered += current.state
            steps++
        }
        val idleAt = idleSince(current)
        if (idleAt != null && idleAt <= now) {
            current = cancelled(current, now)
            entered += SessionState.CANCELLED
            return Settlement(current, entered, idleCancelled = true)
        }
        return Settlement(current, entered, idleCancelled = false)
    }

    /**
     * The next phase or round after a running one, which starts at [at] (the old deadline, or now for an early advance): PLACING ->
     * MOVING, MOVING -> REVIEW, ROTATING r -> r + 1, the last round -> REVIEW (the round stays the last one). Raises the version.
     */
    fun next(session: StoredSession, at: Instant): StoredSession {
        val settings = session.settings
        val (state, round, endsAt) = when (session.state) {
            SessionState.PLACING -> Triple(SessionState.MOVING, 0, at + checkNotNull(settings.movingSeconds).seconds)
            SessionState.MOVING -> Triple(SessionState.REVIEW, 0, null)
            SessionState.ROTATING -> if (session.round + 1 < checkNotNull(settings.rounds)) {
                Triple(SessionState.ROTATING, session.round + 1, at + checkNotNull(settings.roundSeconds).seconds)
            } else {
                Triple(SessionState.REVIEW, session.round, null)
            }
            else -> error("only a running phase has a next one")
        }
        return session.copy(state = state, round = round, phaseEndsAt = endsAt, lastActivityAt = at, version = session.version + 1)
    }

    /** The first phase after the lobby, starting at [at]. */
    fun started(session: StoredSession, at: Instant): StoredSession {
        check(session.state == SessionState.LOBBY) { "only a session in the lobby starts" }
        val (state, endsAt) = when (session.mode) {
            EstimationMode.MAGIC -> SessionState.PLACING to at + checkNotNull(session.settings.placingSeconds).seconds
            EstimationMode.ROTATION -> SessionState.ROTATING to at + checkNotNull(session.settings.roundSeconds).seconds
        }
        return session.copy(
            state = state, round = 0, phaseEndsAt = endsAt, startedAt = at, lastActivityAt = at, version = session.version + 1,
        )
    }

    fun cancelled(session: StoredSession, at: Instant): StoredSession =
        session.copy(state = SessionState.CANCELLED, phaseEndsAt = null, closedAt = at, lastActivityAt = at, version = session.version + 1)

    private fun deadlinePassed(session: StoredSession, now: Instant): Boolean {
        val endsAt = session.phaseEndsAt
        return session.state.running && endsAt != null && endsAt <= now
    }

    /** When [session] becomes idle, or null in a final state. */
    private fun idleSince(session: StoredSession): Instant? = when {
        !session.state.active -> null
        session.state == SessionState.REVIEW -> session.lastActivityAt + REVIEW_IDLE
        else -> session.lastActivityAt + IDLE
    }
}
