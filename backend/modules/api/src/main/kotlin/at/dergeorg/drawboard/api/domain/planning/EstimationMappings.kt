package at.dergeorg.drawboard.api.domain.planning

import at.dergeorg.drawboard.contract.model.EstimationEntry
import at.dergeorg.drawboard.contract.model.EstimationItem
import at.dergeorg.drawboard.contract.model.EstimationItemRef
import at.dergeorg.drawboard.contract.model.EstimationItemRefKind
import at.dergeorg.drawboard.contract.model.EstimationItemResult
import at.dergeorg.drawboard.contract.model.EstimationMode
import at.dergeorg.drawboard.contract.model.EstimationSeat
import at.dergeorg.drawboard.contract.model.EstimationSession
import at.dergeorg.drawboard.contract.model.EstimationSessionMe
import at.dergeorg.drawboard.contract.model.EstimationSessionState
import at.dergeorg.drawboard.contract.model.EstimationSessionSummary
import at.dergeorg.drawboard.contract.model.EstimationSettings
import at.dergeorg.drawboard.contract.model.NewEstimationSession
import at.dergeorg.drawboard.contract.model.PokerDeck
import at.dergeorg.drawboard.contract.model.PokerDeckKind
import at.dergeorg.drawboard.contract.model.PokerValueCount
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.model.Principal
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.planning.domain.sessions.model.EntryView
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRefKind
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemView
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionMe
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionState
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSummary
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionView
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewItemSpec
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewSessionCommand
import kotlin.uuid.Uuid
import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode as DomainMode

/**
 * Contract <-> planning for the estimation sessions. The views come out of the one mapper of the planning module already shaped for
 * the caller (E2-E5, E9); here only names change: a guest never gets a member's user id (`moderatorId` left out, S1.10), and users
 * deleted since read "Deleted user".
 */
internal object EstimationMappings {

    fun command(boardId: Uuid, moderator: Principal.Member, request: NewEstimationSession) = NewSessionCommand(
        boardId = boardId,
        moderator = moderator,
        mode = DomainMode.valueOf(request.mode.name),
        title = request.title,
        deck = DeckSpec(DeckKind.valueOf(request.deck.kind.name), request.deck.propertyValues),
        items = request.items.map { NewItemSpec(ItemRef(ItemRefKind.valueOf(it.ref.kind.name), it.ref.blockId, it.ref.cardId), it.title) },
        anonymous = request.anonymous,
        settings = request.settings.let {
            SessionSettings(
                placingSeconds = it.placingSeconds,
                movingSeconds = it.movingSeconds,
                markThreshold = it.markThreshold,
                rounds = it.rounds,
                roundSeconds = it.roundSeconds,
                advanceWhenDone = it.advanceWhenDone,
            )
        },
    )

    /** The member ids whose names may have to read "Deleted user". */
    fun userIds(view: SessionView): List<Uuid> = listOf(view.moderatorId) + view.seats.mapNotNull { it.userId } +
        view.items.flatMap { item -> item.result?.entries.orEmpty().mapNotNull { it.userId } }

    fun session(view: SessionView, guest: Boolean, names: NameBook) = EstimationSession(
        id = view.id,
        mode = EstimationMode.valueOf(view.mode.name),
        title = view.title,
        deck = PokerDeck(PokerDeckKind.valueOf(view.deck.kind.name), view.deck.values),
        anonymous = view.anonymous,
        settings = settings(view.settings),
        state = state(view.state),
        round = view.round,
        serverTime = view.serverTime,
        moderatorName = names.name(view.moderatorId, view.moderatorName),
        createdAt = view.createdAt,
        version = view.version,
        seats = view.seats.map { EstimationSeat(it.id, names.name(it.userId, it.displayName), it.guest, it.seated, it.done) },
        items = view.items.map { item(it, names) },
        me = me(view.me),
        phaseEndsAt = view.phaseEndsAt,
        moderatorId = if (guest) null else view.moderatorId,
        startedAt = view.startedAt,
        closedAt = view.closedAt,
    )

    fun summary(summary: SessionSummary, names: NameBook) = EstimationSessionSummary(
        id = summary.id,
        mode = EstimationMode.valueOf(summary.mode.name),
        title = summary.title,
        state = state(summary.state),
        round = summary.round,
        moderatorName = names.name(summary.moderatorId, summary.moderatorName),
        createdAt = summary.createdAt,
        seatCount = summary.seatCount,
        itemCount = summary.itemCount,
        me = me(summary.me),
    )

    fun entry(entry: EntryView, names: NameBook? = null) = EstimationEntry(
        `value` = entry.value,
        kept = entry.kept,
        reason = entry.reason,
        displayName = entry.displayName?.let { names?.name(entry.userId, it) ?: it },
        guest = entry.guest,
    )

    fun state(state: SessionState) = EstimationSessionState.valueOf(state.name)

    fun state(state: EstimationSessionState) = SessionState.valueOf(state.name)

    private fun item(item: ItemView, names: NameBook) = EstimationItem(
        id = item.id,
        ref = EstimationItemRef(EstimationItemRefKind.valueOf(item.ref.kind.name), item.ref.blockId, item.ref.cardId),
        title = item.title,
        position = item.position,
        mine = item.mine,
        column = item.column,
        moveCount = item.moveCount,
        marked = item.marked,
        currentValue = item.currentValue,
        myEntry = item.myEntry?.let { entry(it) },
        result = item.result?.let { result ->
            EstimationItemResult(
                propertyEntries = result.entries.map { entry(it, names) },
                distribution = result.distribution.map { PokerValueCount(it.value, it.count) },
                candidates = result.candidates,
                moveTrail = result.moveTrail,
                average = result.average,
                median = result.median,
            )
        },
        decision = item.decision,
        overridden = item.overridden,
    )

    private fun settings(settings: SessionSettings) = EstimationSettings(
        placingSeconds = settings.placingSeconds,
        movingSeconds = settings.movingSeconds,
        markThreshold = settings.markThreshold,
        rounds = settings.rounds,
        roundSeconds = settings.roundSeconds,
        advanceWhenDone = settings.advanceWhenDone,
    )

    private fun me(me: SessionMe) = EstimationSessionMe(seated = me.seated, moderator = me.moderator, seatId = me.seatId)
}
