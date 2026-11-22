package at.dergeorg.drawboard.planning.domain.sessions.model

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.model.ValueCount
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** MAGIC (Magic Estimation) or ROTATION. Same names as `EstimationMode` of the contract. */
enum class EstimationMode { MAGIC, ROTATION }

/**
 * The life of a session (same names as the contract): LOBBY, the running phases PLACING and MOVING (MAGIC) or ROTATING (ROTATION),
 * REVIEW, and the final DONE and CANCELLED. A session never goes back.
 */
enum class SessionState {
    LOBBY, PLACING, MOVING, ROTATING, REVIEW, DONE, CANCELLED;

    /** Every state but DONE and CANCELLED. */
    val active: Boolean get() = this != DONE && this != CANCELLED

    /** A phase with a deadline: PLACING, MOVING, ROTATING. */
    val running: Boolean get() = this == PLACING || this == MOVING || this == ROTATING

    /** REVIEW and DONE: everything of the session is visible to whoever may see it. */
    val revealed: Boolean get() = this == REVIEW || this == DONE

    companion object {
        val ACTIVE: Set<SessionState> = entries.filter { it.active }.toSet()
        val CLOSED: Set<SessionState> = setOf(DONE, CANCELLED)

        /** The states in which a guest sees a session only while holding a seat in it (E9). */
        val FOR_SEATED_GUESTS: Set<SessionState> = setOf(REVIEW, DONE, CANCELLED)
    }
}

/** What a card refers to in the board's document: a story card block, or a card of a kanban board block. */
enum class ItemRefKind { STORY, KANBAN_CARD }

/** An untrusted hint into the Yjs document (E20): ids checked for their form only, never looked up. */
data class ItemRef(val kind: ItemRefKind, val blockId: String, val cardId: String?)

/**
 * The timing and rules of a session, fixed at creation (E1). The fields of the other mode are null; in a stored session the
 * defaults of the own mode are filled in.
 */
data class SessionSettings(
    val placingSeconds: Int? = null,
    val movingSeconds: Int? = null,
    val markThreshold: Int? = null,
    val rounds: Int? = null,
    val roundSeconds: Int? = null,
    val advanceWhenDone: Boolean? = null,
)

/**
 * Who looks at a session and what the board lets them do there, as module `api` found out: [editor] for the roles EDITOR and OWNER of a
 * signed-in user, [owner] for OWNER. A guest is neither (guests never moderate, E8). Only used to tell whether the caller moderates.
 */
data class Viewer(val principal: Principal, val editor: Boolean, val owner: Boolean) {

    /** E13: the creator while still EDITOR or OWNER, or the board's OWNER. */
    fun moderates(moderatorId: Uuid): Boolean = principal is Principal.Member && (owner || (editor && principal.id == moderatorId))
}

/**
 * A session as one caller sees it (E2-E5, E9): the same for everyone who may see it, except their own cards and [me]. Built by one
 * mapper for every answer. [moderatorId] is for `api` (left out for guests there); [boardId] too.
 */
data class SessionView(
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
    val serverTime: Instant,
    val moderatorId: Uuid,
    val moderatorName: String,
    val createdAt: Instant,
    val startedAt: Instant?,
    val closedAt: Instant?,
    val version: Long,
    val seats: List<SeatView>,
    val items: List<ItemView>,
    val me: SessionMe,
)

/** A listed seat; never which cards it holds or what it entered. [userId] is set for members only, for `api` (deleted users). */
data class SeatView(val id: Uuid, val displayName: String, val guest: Boolean, val seated: Boolean, val done: Boolean, val userId: Uuid?)

/** The caller's own relation to a session: their seat (never another one), whether it takes part, whether they moderate. */
data class SessionMe(val seatId: Uuid?, val seated: Boolean, val moderator: Boolean)

/** One card as the caller sees it; which fields are set depends on mode, state and the caller (see `EstimationItem` of the contract). */
data class ItemView(
    val id: Uuid,
    val ref: ItemRef,
    val title: String,
    val position: Int,
    val mine: Boolean,
    val column: String? = null,
    val moveCount: Int? = null,
    val marked: Boolean? = null,
    val currentValue: String? = null,
    val myEntry: EntryView? = null,
    val result: ItemResult? = null,
    val decision: String? = null,
    val overridden: Boolean? = null,
)

/** The outcome of one card from REVIEW on; [entries] and [moveTrail] are empty 30 days after DONE (E22). */
data class ItemResult(
    val entries: List<EntryView>,
    val average: Double?,
    val median: Double?,
    val distribution: List<ValueCount>,
    val candidates: List<String>,
    val moveTrail: List<String>,
)

/** A Rotation entry: the caller's own (`myEntry`) or a revealed one; names only in a result of a session that is not anonymous. */
data class EntryView(
    val value: String,
    val reason: String?,
    val kept: Boolean,
    val displayName: String? = null,
    val guest: Boolean? = null,
    val userId: Uuid? = null,
)

/** A session as the list shows it: never items, seats or entries (E17). */
data class SessionSummary(
    val id: Uuid,
    val mode: EstimationMode,
    val title: String,
    val state: SessionState,
    val round: Int,
    val moderatorId: Uuid,
    val moderatorName: String,
    val createdAt: Instant,
    val seatCount: Int,
    val itemCount: Int,
    val me: SessionMe,
)

/** Who moderates a session, for the 403 decisions of `api` (E13); the state as the server clock has it now. */
data class SessionHeader(val moderatorId: Uuid, val state: SessionState)
