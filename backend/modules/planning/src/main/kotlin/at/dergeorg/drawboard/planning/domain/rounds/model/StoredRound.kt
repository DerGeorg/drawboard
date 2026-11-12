package at.dergeorg.drawboard.planning.domain.rounds.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** A round as the database holds it (without its participants). Internal: the outside world sees [RoundView]. */
internal data class StoredRound(
    val id: Uuid,
    val boardId: Uuid,
    val storyBlockId: String?,
    val title: String,
    val deck: Deck,
    val state: RoundState,
    val facilitatorId: Uuid,
    val facilitatorName: String,
    val createdAt: Instant,
    val closedAt: Instant?,
    val revealedAt: Instant?,
    val version: Long,
)

/** USER or GUEST: the kind of principal [StoredParticipant.principalId] is. */
internal enum class ParticipantKind { USER, GUEST }

/** A participant with the vote, which only the service sees (and only [RoundView] shows, shaped for the caller). */
internal data class StoredParticipant(
    val id: Uuid,
    val roundId: Uuid,
    val kind: ParticipantKind,
    val principalId: Uuid,
    val shareId: Uuid?,
    val displayName: String,
    val position: Int,
    val vote: String?,
    val joinedAt: Instant,
) {
    val guest: Boolean get() = kind == ParticipantKind.GUEST
}
