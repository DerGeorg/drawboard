package at.dergeorg.drawboard.collab.domain.rooms.model

import kotlin.time.Instant
import kotlin.uuid.Uuid

/** The answer to "may this handshake become a session?", decided BEFORE the WebSocket upgrade. */
sealed interface Admission {

    /** The ticket was valid and is used up; [role] was resolved just now. */
    data class Admitted(
        val boardId: Uuid,
        val userId: Uuid,
        val displayName: String,
        val tokenExpiresAt: Instant,
        val role: CollabRole,
        val groups: Set<String> = emptySet(),
        val shareId: Uuid? = null,
        /** Where a guest connects from (counted per address, S2.5); null for signed-in users. */
        val clientAddress: String? = null,
    ) : Admission {
        val participant: Participant get() = Participant(userId, groups, shareId)
    }

    data class Rejected(val reason: RejectionReason) : Admission
}

/** Why a handshake is refused; the WebSocket layer picks the HTTP status. */
enum class RejectionReason {
    /** Unknown, used, expired or foreign ticket: 401. */
    UNKNOWN_TICKET,

    /** The user has no role on the board (any more): 404. */
    NO_ACCESS,

    /** 20 sessions of the user or 200 of the board are open: 429. */
    TOO_MANY_SESSIONS,

    /** The owner is restoring a version right now: retry in a moment (429). */
    BOARD_BUSY,
}
