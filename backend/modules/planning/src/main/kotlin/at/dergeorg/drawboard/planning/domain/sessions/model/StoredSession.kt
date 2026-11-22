package at.dergeorg.drawboard.planning.domain.sessions.model

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.ParticipantKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * A session as the database holds it, without seats, cards, entries and moves. Internal: the outside world sees [SessionView].
 * [lastActivityAt] is the last write or transition (idle cancel, E22); [reducedAt] is when the retention purge reduced its entries to
 * numbers (E22).
 */
internal data class StoredSession(
    val id: Uuid,
    val boardId: Uuid,
    val mode: EstimationMode,
    val title: String,
    val deck: Deck,
    val anonymous: Boolean,
    val settings: SessionSettings,
    val state: SessionState,
    val round: Int,
    val phaseEndsAt: Instant?,
    val moderatorId: Uuid,
    val moderatorName: String,
    val itemCount: Int,
    val createdAt: Instant,
    val startedAt: Instant?,
    val closedAt: Instant?,
    val lastActivityAt: Instant,
    val reducedAt: Instant?,
    val version: Long,
)

/**
 * A seat. [id] is a random UUID of this session only (S1.10), never the user id. [slot] is the secret place in the ring, assigned at
 * the start with `SecureRandom` (E2) and dropped when the session enters REVIEW (anonymous sessions and Magic); null for watchers.
 * [removed]: the seat's share link was revoked in a running phase (E11); such a seat is never listed.
 */
internal data class StoredSeat(
    val id: Uuid,
    val sessionId: Uuid,
    val kind: ParticipantKind,
    val principalId: Uuid,
    val shareId: Uuid?,
    val displayName: String,
    val position: Int,
    val joinedAt: Instant,
    val seated: Boolean,
    val slot: Int?,
    val removed: Boolean,
) {
    val guest: Boolean get() = kind == ParticipantKind.GUEST

    /** Picked at the start, has its slot and was not removed: it holds cards. */
    val inRing: Boolean get() = slot != null && seated && !removed

    fun isPrincipal(who: Principal): Boolean = principalId == who.id && guest == (who is Principal.Guest)
}

/**
 * A card of a session. MAGIC: [column], [moveCount] and [marked] (kept up to date in MOVING, frozen when REVIEW starts);
 * [touched]: a seat that was removed for a revoked link placed or moved it (always marked). [decision] and [overridden] from REVIEW.
 */
internal data class StoredItem(
    val id: Uuid,
    val sessionId: Uuid,
    val position: Int,
    val ref: ItemRef,
    val title: String,
    val column: String?,
    val moveCount: Int,
    val marked: Boolean,
    val touched: Boolean,
    val decision: String?,
    val overridden: Boolean,
)

/**
 * A Rotation entry: one per card and round; its [id] is random (no time in it). [seatId] and [createdAt] are null from REVIEW on in
 * anonymous sessions (E5: nothing to correlate with request logs) and after the retention purge; [shuffle] is a random key that orders
 * the entries of a card in REVIEW - never by round, so the ring cannot be computed back (E5).
 */
internal data class StoredEntry(
    val id: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val seatId: Uuid?,
    val round: Int,
    val value: String,
    val reason: String?,
    val kept: Boolean,
    val shuffle: Long,
    val createdAt: Instant?,
)

/**
 * A Magic move in MOVING; its [id] is random (no time in it). [seatId] counts the per-seat limits and marks, [at] decides whether a
 * move merges with the previous one; both are null from REVIEW on, whatever `anonymous` says (E4) - [seq], the order within the
 * session, is all that is kept.
 */
internal data class StoredMove(
    val id: Uuid,
    val sessionId: Uuid,
    val itemId: Uuid,
    val seatId: Uuid?,
    val fromValue: String?,
    val toValue: String,
    val at: Instant?,
    val seq: Long,
)
