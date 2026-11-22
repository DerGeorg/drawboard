package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemView
import at.dergeorg.drawboard.planning.domain.sessions.model.SeatView
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionMe
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSummary
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredItem
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredMove
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSeat
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession
import at.dergeorg.drawboard.planning.domain.sessions.model.Viewer
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Everything of one session the view needs; [entries] and [moves] may be empty where the state shows none of them. */
internal class Snapshot(
    val session: StoredSession,
    val seats: List<StoredSeat>,
    val items: List<StoredItem>,
    val entries: List<StoredEntry> = emptyList(),
    val moves: List<StoredMove> = emptyList(),
)

/**
 * THE one mapper from a stored session to what one caller may see (E2-E5, E9), used for get and for the answers of create, start,
 * advance, finish and cancel - so no answer can show more than get. Before REVIEW:
 *
 * * nobody learns who holds, placed or moved a card: `mine` only for the caller's own cards, no slot, progress per seat (`done`) only;
 * * MAGIC PLACING: `column` only on the caller's own cards; MOVING: columns, `moveCount`, `marked` for everyone, never the mover;
 * * ROTATION ROTATING: `currentValue` (the latest earlier value, no author, reason or round) and `myEntry` only for the holder - not
 *   for the moderator, not for the board's OWNER.
 *
 * From REVIEW on everyone who may see the session sees the same results ([SessionResults]); a CANCELLED session shows none. A guest
 * sees a session in REVIEW, DONE or CANCELLED only while holding a seat in it (null otherwise).
 */
internal object SessionViews {

    /** How long single values and reasons of a DONE session are shown (E22). */
    val RETENTION: Duration = 30.days

    /** E9: whether [principal] may see [session] at all, given their own seat. */
    fun visible(session: StoredSession, principal: Principal, own: StoredSeat?): Boolean =
        principal !is Principal.Guest || session.state !in SessionState.FOR_SEATED_GUESTS || (own != null && !own.removed)

    /** Whether the single values and reasons of [session] are gone for good at [now] (E22, enforced on read). */
    fun reduced(session: StoredSession, now: Instant): Boolean {
        val closedAt = session.closedAt
        return session.reducedAt != null || (session.state == SessionState.DONE && closedAt != null && now >= closedAt + RETENTION)
    }

    fun view(snapshot: Snapshot, viewer: Viewer, now: Instant): SessionView? {
        val session = snapshot.session
        val own = snapshot.seats.firstOrNull { it.isPrincipal(viewer.principal) && !it.removed }
        if (!visible(session, viewer.principal, own)) return null
        val listed = snapshot.seats.filter { !it.removed }
        val done = Progress.doneSeats(session, snapshot.seats, snapshot.items, snapshot.entries)
        val reduced = reduced(session, now)
        val seatsById = snapshot.seats.associateBy { it.id }
        return SessionView(
            id = session.id,
            boardId = session.boardId,
            mode = session.mode,
            title = session.title,
            deck = session.deck,
            anonymous = session.anonymous,
            settings = session.settings,
            state = session.state,
            round = session.round,
            phaseEndsAt = session.phaseEndsAt.takeIf { session.state.running },
            serverTime = now,
            moderatorId = session.moderatorId,
            moderatorName = session.moderatorName,
            createdAt = session.createdAt,
            startedAt = session.startedAt,
            closedAt = session.closedAt,
            version = session.version,
            seats = listed.sortedBy { it.position }.map {
                SeatView(it.id, it.displayName, it.guest, it.seated, it.id in done, it.takeUnless { seat -> seat.guest }?.principalId)
            },
            items = snapshot.items.sortedBy { it.position }.map { item(snapshot, own, it, seatsById, reduced) },
            me = me(session, own, viewer),
        )
    }

    /** The list entry of [session] for [viewer], or null if a guest may not see it (E9). Never items, seats or entries (E17). */
    fun summary(session: StoredSession, seats: List<StoredSeat>, viewer: Viewer): SessionSummary? {
        val own = seats.firstOrNull { it.isPrincipal(viewer.principal) && !it.removed }
        if (!visible(session, viewer.principal, own)) return null
        return SessionSummary(
            id = session.id,
            mode = session.mode,
            title = session.title,
            state = session.state,
            round = session.round,
            moderatorId = session.moderatorId,
            moderatorName = session.moderatorName,
            createdAt = session.createdAt,
            seatCount = seats.count { !it.removed },
            itemCount = session.itemCount,
            me = me(session, own, viewer),
        )
    }

    private fun me(session: StoredSession, own: StoredSeat?, viewer: Viewer) =
        SessionMe(seatId = own?.id, seated = own?.seated == true, moderator = viewer.moderates(session.moderatorId))

    private fun item(
        snapshot: Snapshot,
        own: StoredSeat?,
        item: StoredItem,
        seats: Map<Uuid, StoredSeat>,
        reduced: Boolean,
    ): ItemView {
        val session = snapshot.session
        val state = session.state
        val mine = Ring.holds(session, snapshot.seats, own, item)
        val magic = session.mode == EstimationMode.MAGIC
        val board = magic && (state == SessionState.MOVING || state.revealed)
        val holding = !magic && state == SessionState.ROTATING && mine
        return ItemView(
            id = item.id,
            ref = item.ref,
            title = item.title,
            position = item.position,
            mine = mine,
            column = item.column.takeIf { board || (magic && state == SessionState.PLACING && mine) },
            moveCount = item.moveCount.takeIf { board },
            marked = item.marked.takeIf { board },
            currentValue = if (holding) currentValue(snapshot.entries, item, session.round) else null,
            myEntry = if (holding) myEntry(snapshot.entries, item, session.round) else null,
            result = if (state.revealed) SessionResults.of(session, item, snapshot.entries, snapshot.moves, seats, reduced) else null,
            decision = item.decision.takeIf { state.revealed },
            overridden = item.overridden.takeIf { state.revealed && item.decision != null },
        )
    }

    /** The latest value entered for [item] in an earlier round, without author, reason or round (E4). */
    fun currentValue(entries: List<StoredEntry>, item: StoredItem, round: Int): String? =
        entries.filter { it.itemId == item.id && it.round < round }.maxByOrNull { it.round }?.value

    private fun myEntry(entries: List<StoredEntry>, item: StoredItem, round: Int): EntryView? =
        entries.firstOrNull { it.itemId == item.id && it.round == round }?.let { EntryView(it.value, it.reason, it.kept) }
}
