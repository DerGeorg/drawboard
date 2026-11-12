package at.dergeorg.drawboard.planning.domain.rounds.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** OPEN (voting, values secret), REVEALED or CANCELLED (closed for good; they never change again). Same names as the contract. */
enum class RoundState { OPEN, REVEALED, CANCELLED }

/** Same names as `PokerDeckKind` of the contract. */
enum class DeckKind { FIBONACCI, TSHIRT, CUSTOM }

/** The cards voters choose from, in the order the UI shows them (lowest estimate first: the order breaks ties). */
data class Deck(val kind: DeckKind, val values: List<String>) {
    companion object {
        val FIBONACCI = Deck(DeckKind.FIBONACCI, listOf("0", "1", "2", "3", "5", "8", "13", "21", "?", "coffee"))
        val TSHIRT = Deck(DeckKind.TSHIRT, listOf("XS", "S", "M", "L", "XL", "?"))
    }
}

/**
 * Who takes part, as the planning module needs to know it: a signed-in user (their own id) or a guest (the id of the guest
 * session, the random part of the token's `sub`, and the link it came through). Built by module `api`; the module knows no tokens.
 */
sealed interface Principal {
    val id: Uuid

    /** The name shown to the others; frozen into the round when the participant joins. */
    val displayName: String

    data class Member(override val id: Uuid, override val displayName: String) : Principal

    data class Guest(override val id: Uuid, override val displayName: String, val shareId: Uuid) : Principal
}

/** A participant as the round shows it. [userId] is set for members only; `api` uses it to find deleted users and never sends it. */
data class ParticipantView(val displayName: String, val guest: Boolean, val voted: Boolean, val userId: Uuid?)

/** One revealed vote. */
data class ResultVote(val displayName: String, val guest: Boolean, val value: String, val userId: Uuid?)

/** How often one deck value was chosen. */
data class ValueCount(val value: String, val count: Int)

/** The outcome of a revealed round; [average] and [median] are rounded to two decimals and null without a numeric vote. */
data class RoundResult(
    val votes: List<ResultVote>,
    val average: Double?,
    val median: Double?,
    val distribution: List<ValueCount>,
    val suggestion: String?,
)

/**
 * A round as one caller sees it: while OPEN nobody sees any value but their own ([myVote]); after the reveal [result] has all of them.
 * [facilitatorId] is for `api` (it is left out for guests there). [storyBlockId] is null for a quick round without a story card.
 */
data class RoundView(
    val id: Uuid,
    val boardId: Uuid,
    val storyBlockId: String?,
    val title: String,
    val deck: Deck,
    val state: RoundState,
    val facilitatorId: Uuid,
    val facilitatorName: String,
    val createdAt: Instant,
    val revealedAt: Instant?,
    val version: Long,
    val participants: List<ParticipantView>,
    val myVote: String?,
    val result: RoundResult?,
)

/** Who may close a round, for the 403 decision of `api`: the facilitator and the state, nothing else. */
data class RoundHeader(val facilitatorId: Uuid, val state: RoundState)
