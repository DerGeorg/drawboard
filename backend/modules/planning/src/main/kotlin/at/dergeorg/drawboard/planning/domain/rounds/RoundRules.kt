package at.dergeorg.drawboard.planning.domain.rounds

import at.dergeorg.drawboard.planning.domain.rounds.model.Deck
import at.dergeorg.drawboard.planning.domain.rounds.model.DeckKind
import at.dergeorg.drawboard.planning.domain.rounds.provides.DeckSpec
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import java.text.Normalizer

/**
 * What a new round must look like beyond the contract's bean validation (which the domain does not rely on): the story card id, the
 * title and the deck. Control and format characters (Unicode Cc/Cf: line breaks, zero-width joiners, right-to-left overrides) are
 * rejected in the title and in the deck values, and custom values must be distinct after NFC normalisation, so two cards never look alike.
 */
internal object RoundRules {

    const val TITLE_MAX = 200
    const val VALUE_MAX = 8
    const val DECK_MIN = 2
    const val DECK_MAX = 20

    private val INVISIBLE_TYPES = setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt())
    private val STORY_BLOCK_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    /** The story card id, or null for a quick round that belongs to no card. */
    fun storyBlockId(raw: String?): String? {
        if (raw != null && !STORY_BLOCK_ID.matches(raw)) throw invalid("storyBlockId", "Pattern", "must be a lowercase UUID")
        return raw
    }

    /** The title without surrounding whitespace; 1 to 200 characters, none of them a control or format character. */
    fun title(raw: String): String {
        val title = raw.trim()
        if (title.isEmpty() || title.length > TITLE_MAX) throw invalid("title", "Size", "must have 1 to $TITLE_MAX characters")
        if (hasInvisible(title)) throw invalid("title", "Pattern", "must not contain control or format characters")
        return title
    }

    fun deck(spec: DeckSpec): Deck = when (spec.kind) {
        DeckKind.FIBONACCI -> Deck.FIBONACCI
        DeckKind.TSHIRT -> Deck.TSHIRT
        DeckKind.CUSTOM -> custom(spec.values)
    }

    private fun custom(values: List<String>?): Deck {
        if (values == null || values.size !in DECK_MIN..DECK_MAX) {
            throw invalid("deck.values", "Size", "a custom deck needs $DECK_MIN to $DECK_MAX values")
        }
        values.forEach(::checkValue)
        if (values.map { Normalizer.normalize(it, Normalizer.Form.NFC) }.toSet().size != values.size) {
            throw invalid("deck.values", "Unique", "values must be distinct after Unicode normalisation")
        }
        return Deck(DeckKind.CUSTOM, values)
    }

    private fun checkValue(value: String) {
        val problem = when {
            value.isEmpty() || value.length > VALUE_MAX -> "Size" to "a value has 1 to $VALUE_MAX characters"
            hasInvisible(value) -> "Pattern" to "a value must not contain control or format characters"
            isBlank(value.codePointAt(0)) || isBlank(value.codePointBefore(value.length)) ->
                "Pattern" to "a value must not start or end with whitespace"
            else -> null
        }
        if (problem != null) throw invalid("deck.values", problem.first, problem.second)
    }

    private fun hasInvisible(text: String): Boolean =
        text.codePoints().anyMatch { Character.getType(it) in INVISIBLE_TYPES }

    private fun isBlank(codePoint: Int): Boolean = Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint)

    private fun invalid(field: String, constraint: String, message: String) =
        ValidationFailedException(listOf(InvalidField(field, constraint, message)))
}
