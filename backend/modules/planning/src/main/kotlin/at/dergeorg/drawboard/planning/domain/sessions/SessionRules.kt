package at.dergeorg.drawboard.planning.domain.sessions

import at.dergeorg.drawboard.planning.domain.sessions.model.EstimationMode
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRef
import at.dergeorg.drawboard.planning.domain.sessions.model.ItemRefKind
import at.dergeorg.drawboard.planning.domain.sessions.model.SessionSettings
import at.dergeorg.drawboard.planning.domain.sessions.provides.NewItemSpec
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import java.text.Normalizer

/**
 * What a new session and the texts of the seats must look like beyond the contract's bean validation, which the domain does not rely
 * on (E1, E12, C1): texts are one line of plain text, normalised to NFC, without control or format characters (Unicode Cc/Cf) and
 * without the line and paragraph separators U+2028/U+2029, trimmed and checked for blank Unicode-aware; the settings fit the mode;
 * 1 to 50 cards with refs of the right form, each at most once. Every violation of one request is reported at once.
 */
internal object SessionRules {

    const val TITLE_MAX = 200
    const val REASON_MAX = 280
    const val ITEMS_MAX = 50
    const val PLACING_MIN = 30
    const val PLACING_MAX = 900
    const val MOVING_MIN = 30
    const val MOVING_MAX = 1800
    const val MARK_MIN = 3
    const val MARK_MAX = 20
    const val MARK_DEFAULT = 3
    const val ROUNDS_MAX = 10
    const val ROUND_SECONDS_MIN = 30
    const val ROUND_SECONDS_MAX = 900

    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val REFUSED_TYPES = setOf(
        Character.CONTROL.toInt(), Character.FORMAT.toInt(), Character.LINE_SEPARATOR.toInt(), Character.PARAGRAPH_SEPARATOR.toInt(),
    )

    /** One line of text as stored: NFC, trimmed, 1 to [max] characters; null with the violation in [violations] otherwise. */
    fun line(raw: String, field: String, max: Int, violations: MutableList<InvalidField>): String? {
        val normalised = Normalizer.normalize(raw, Normalizer.Form.NFC)
        val text = trim(normalised)
        val problem = when {
            // before the trim: a trailing line break or U+2028 is refused, not cut off
            normalised.codePoints().anyMatch { Character.getType(it) in REFUSED_TYPES } ->
                "Pattern" to "must be one line without control or format characters"
            text.isEmpty() -> "NotBlank" to "must not be blank"
            text.codePointCount(0, text.length) > max -> "Size" to "must have at most $max characters"
            else -> null
        }
        if (problem != null) violations += InvalidField(field, problem.first, problem.second)
        return text.takeIf { problem == null }
    }

    /** [line] for a single field: throws 400 VALIDATION_FAILED. */
    fun line(raw: String, field: String, max: Int): String {
        val violations = mutableListOf<InvalidField>()
        return line(raw, field, max, violations) ?: throw ValidationFailedException(violations)
    }

    /** The settings of [mode] with its defaults filled in; the other mode's fields must be absent (E1, contract). */
    fun settings(mode: EstimationMode, spec: SessionSettings, violations: MutableList<InvalidField>): SessionSettings {
        val magic = mode == EstimationMode.MAGIC
        fun required(name: String, value: Int?, range: IntRange) {
            when {
                value == null -> violations += InvalidField("settings.$name", "NotNull", "is required for $mode")
                value !in range -> violations += InvalidField("settings.$name", "Range", "must be ${range.first} to ${range.last}")
            }
        }
        fun forbidden(name: String, value: Any?) {
            if (value != null) violations += InvalidField("settings.$name", "Null", "is not a setting of $mode")
        }
        if (magic) {
            required("placingSeconds", spec.placingSeconds, PLACING_MIN..PLACING_MAX)
            required("movingSeconds", spec.movingSeconds, MOVING_MIN..MOVING_MAX)
            if (spec.markThreshold != null) required("markThreshold", spec.markThreshold, MARK_MIN..MARK_MAX)
            forbidden("rounds", spec.rounds)
            forbidden("roundSeconds", spec.roundSeconds)
            forbidden("advanceWhenDone", spec.advanceWhenDone)
            return SessionSettings(
                placingSeconds = spec.placingSeconds,
                movingSeconds = spec.movingSeconds,
                markThreshold = spec.markThreshold ?: MARK_DEFAULT,
            )
        }
        required("rounds", spec.rounds, 1..ROUNDS_MAX)
        required("roundSeconds", spec.roundSeconds, ROUND_SECONDS_MIN..ROUND_SECONDS_MAX)
        forbidden("placingSeconds", spec.placingSeconds)
        forbidden("movingSeconds", spec.movingSeconds)
        forbidden("markThreshold", spec.markThreshold)
        return SessionSettings(rounds = spec.rounds, roundSeconds = spec.roundSeconds, advanceWhenDone = spec.advanceWhenDone ?: true)
    }

    /** The cards with their titles as stored; refs of the right form, each at most once per session (E20). */
    fun items(specs: List<NewItemSpec>, violations: MutableList<InvalidField>): List<NewItemSpec> {
        if (specs.isEmpty() || specs.size > ITEMS_MAX) violations += InvalidField("items", "Size", "a session has 1 to $ITEMS_MAX cards")
        val seen = mutableSetOf<String>()
        return specs.mapIndexedNotNull { index, spec ->
            val field = "items[$index]"
            val refOk = checkRef(spec.ref, "$field.ref", violations)
            if (refOk && !seen.add(key(spec.ref))) violations += InvalidField("$field.ref", "Unique", "each card at most once")
            val title = line(spec.title, "$field.title", TITLE_MAX, violations)
            if (title == null || !refOk) null else spec.copy(title = title)
        }
    }

    /** The key that makes a ref unique within a session. */
    fun key(ref: ItemRef): String = listOfNotNull(ref.kind.name, ref.blockId, ref.cardId).joinToString("/")

    private fun checkRef(ref: ItemRef, field: String, violations: MutableList<InvalidField>): Boolean {
        val before = violations.size
        if (!UUID.matches(ref.blockId)) violations += InvalidField("$field.blockId", "Pattern", "must be a lowercase UUID")
        when (ref.kind) {
            ItemRefKind.STORY -> if (ref.cardId != null) {
                violations += InvalidField("$field.cardId", "Null", "a story card has no card id")
            }
            ItemRefKind.KANBAN_CARD -> if (ref.cardId == null || !UUID.matches(ref.cardId)) {
                violations += InvalidField("$field.cardId", "Pattern", "a kanban card needs its card id, a lowercase UUID")
            }
        }
        return violations.size == before
    }

    /** Strips leading and trailing whitespace, Unicode-aware (also NBSP and the other space separators). */
    private fun trim(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && isBlank(text.codePointAt(start))) start += Character.charCount(text.codePointAt(start))
        while (end > start && isBlank(text.codePointBefore(end))) end -= Character.charCount(text.codePointBefore(end))
        return text.substring(start, end)
    }

    private fun isBlank(codePoint: Int): Boolean = Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint)
}
