package at.dergeorg.drawboard.planning.domain.sessions.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the estimation session events (S7.1, E23): counts only. Never a value, a reason, a move, a join, a slot or which
// seat entered what; refusals are metrics. The title is left out as well.
// Rules: the logical name never changes; a new field needs a default; a change of meaning gets a new name (.v2).

/** A session was created on [boardId]: its mode, the number of cards and the kind of deck. */
@AuditDetails(type = "planning.session-created")
data class SessionCreated(val boardId: String, val mode: String, val items: Int, val deck: String) : DomainEventDetails

/** A session was started with [memberSeats] seats of members and [guestSeats] of guests. */
@AuditDetails(type = "planning.session-started")
data class SessionStarted(val boardId: String, val memberSeats: Int, val guestSeats: Int) : DomainEventDetails

/** A session was finished with [decisions] decided cards, [overridden] of them against what the session produced. */
@AuditDetails(type = "planning.session-finished")
data class SessionFinished(val boardId: String, val decisions: Int, val overridden: Int) : DomainEventDetails

/** A session was cancelled - by its moderator, or ([idle] true) by the server after a time without activity. */
@AuditDetails(type = "planning.session-cancelled")
data class SessionCancelled(val boardId: String, val idle: Boolean) : DomainEventDetails

/** The moderator decided card [itemId] against what the session produced (E13). Never the value. */
@AuditDetails(type = "planning.session-decision-overridden")
data class DecisionOverridden(val boardId: String, val itemId: String) : DomainEventDetails
