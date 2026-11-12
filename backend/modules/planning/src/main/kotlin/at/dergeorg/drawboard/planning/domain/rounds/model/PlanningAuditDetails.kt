package at.dergeorg.drawboard.planning.domain.rounds.model

import at.dergeorg.drawboard.shared.auditing.AuditDetails
import at.dergeorg.drawboard.shared.auditing.DomainEventDetails

// Typed details of the planning events (S7.1). Never a vote, never a join; the title is left out as well.
// Rules: the logical name never changes; a new field needs a default; a change of meaning gets a new name (.v2).

/**
 * A round was started: on which board and story card ([storyBlockId] null for a quick round without a card), by whom (the event
 * itself carries the round id and the actor).
 */
@AuditDetails(type = "planning.round-created")
data class RoundCreated(val boardId: String, val storyBlockId: String?, val facilitatorId: String, val deck: String) : DomainEventDetails

/** A round was revealed by [actorId]. The number of votes, members and guests apart - never the votes themselves. */
@AuditDetails(type = "planning.round-revealed")
data class RoundRevealed(
    val boardId: String,
    val storyBlockId: String?,
    val actorId: String,
    val memberVotes: Int,
    val guestVotes: Int,
) : DomainEventDetails

/** A round was cancelled by [actorId]; its votes are gone. */
@AuditDetails(type = "planning.round-cancelled")
data class RoundCancelled(val boardId: String, val storyBlockId: String?, val actorId: String) : DomainEventDetails
