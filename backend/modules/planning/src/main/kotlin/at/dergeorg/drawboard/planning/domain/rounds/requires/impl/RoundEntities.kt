package at.dergeorg.drawboard.planning.domain.rounds.requires.impl

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Table
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Row of `planning.poker_round`. Only used inside requires/impl; the domain sees `StoredRound`. */
@Table(schema = "planning", name = "poker_round")
internal data class RoundEntity(
    @Id val id: Uuid,
    val boardId: Uuid,
    val storyBlockId: String?,
    val title: String,
    val deckKind: String,
    /** The cards, separated by a line feed (a card never contains one: control characters are rejected). */
    val deckValues: String,
    val state: String,
    val facilitatorId: Uuid,
    val facilitatorName: String,
    val createdAt: Instant,
    val closedAt: Instant?,
    val revealedAt: Instant?,
    val version: Long,
)

/** Row of `planning.poker_participant`. */
@Table(schema = "planning", name = "poker_participant")
internal data class ParticipantEntity(
    @Id val id: Uuid,
    val roundId: Uuid,
    val kind: String,
    val principalId: Uuid,
    val shareId: Uuid?,
    val displayName: String,
    val position: Int,
    val vote: String?,
    val joinedAt: Instant,
)
