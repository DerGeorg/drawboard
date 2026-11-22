package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.StoredEntry
import at.dergeorg.drawboard.planning.domain.sessions.model.StoredSession

/** How a Rotation holder's input is taken: the outcome of [RotationRules.entry]. */
internal sealed interface RotationInput {
    /** Stored as an entry; [reason] only when the value changed a previous one, [kept] when it is that previous value. */
    data class Entry(val reason: String?, val kept: Boolean) : RotationInput

    /** Another value than `currentValue` without a reason (400 `PLANNING_REASON_REQUIRED`). */
    data object ReasonRequired : RotationInput
}

/**
 * The rules of Rotation that [at.dergeorg.drawboard.planning.domain.EstimationPlayService] applies (E4, E13, contract
 * `setRotationEstimate` and `decideEstimationItem`):
 *
 * * any deck value, `coffee` included; the same value as `currentValue` keeps it (a reason is discarded); another one needs a reason;
 *   a card without `currentValue` needs none - tied to the card, not to the first holder (C SHOULD) - and keeps none (E6);
 * * a decision is one of the values entered for the card; any deck value only when the card has no entry, and then it is
 *   `overridden`.
 */
internal object RotationRules {

    fun entry(current: String?, value: String, reason: String?): RotationInput = when {
        current == null -> RotationInput.Entry(reason = null, kept = false)
        value == current -> RotationInput.Entry(reason = null, kept = true)
        reason == null -> RotationInput.ReasonRequired
        else -> RotationInput.Entry(reason = reason, kept = false)
    }

    /** Whether a decision of [value] is allowed for a card with [entries] - null if not - and whether it is overridden (E13). */
    fun decision(session: StoredSession, entries: List<StoredEntry>, value: String): Boolean? = when {
        entries.isNotEmpty() -> if (entries.any { it.value == value }) false else null
        value in session.deck.values -> true
        else -> null
    }
}
