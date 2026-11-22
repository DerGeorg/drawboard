package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.GifResults
import at.dergeorg.drawboard.gifs.domain.search.model.GifSummary
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamGif
import at.dergeorg.drawboard.gifs.domain.search.requires.UpstreamPage
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException

/**
 * The rules of the module that need no state: what a search text is, and what of GIPHY's answer is let through (G4). Whatever
 * GIPHY sends is untrusted: an entry that does not fit is dropped, a title is cleaned. The client builds the image address from the
 * id and a fixed base (G9), so an id outside the pattern would be a path into somebody else's URL.
 */
internal object GifRules {
    const val PAGE_SIZE = 24
    const val MAX_PAGE = 9
    const val MIN_TERM = 2
    const val MAX_TERM = 50
    const val MAX_TITLE = 200
    const val MAX_SIZE = 4096
    const val DEFAULT_LANG = "en"

    private val ID = Regex("[A-Za-z0-9]{1,64}")
    private val LANG = Regex("[a-z]{2}")
    private val WHITESPACE = Regex("[\\s\\p{Z}]+")

    /**
     * The search text as it is cached and sent: trimmed, every run of white space one blank, lower case. At least [MIN_TERM] and at
     * most [MAX_TERM] characters and no control character, otherwise `VALIDATION_FAILED` (the value is never echoed).
     */
    fun term(raw: String): String {
        val text = raw.trim().replace(WHITESPACE, " ").lowercase()
        val length = text.codePointCount(0, text.length)
        when {
            length < MIN_TERM -> throw invalid("q", "Size", "size must be at least $MIN_TERM")
            length > MAX_TERM -> throw invalid("q", "Size", "size must be at most $MAX_TERM")
            text.any { Character.isISOControl(it) } -> throw invalid("q", "Pattern", "must not contain control characters")
        }
        return text
    }

    /** The language of the search text; absent = [DEFAULT_LANG]. */
    fun lang(raw: String?): String {
        val text = raw ?: return DEFAULT_LANG
        if (!LANG.matches(text)) throw invalid("lang", "Pattern", "must be a two-letter language code")
        return text
    }

    fun page(raw: Int): Int {
        if (raw !in 0..MAX_PAGE) throw invalid("page", "Range", "must be between 0 and $MAX_PAGE")
        return raw
    }

    /** [page] of the search answered with [upstream]; the first page of the trending list when [page] is null. */
    fun results(upstream: UpstreamPage, page: Int?): GifResults {
        val items = upstream.entries.take(PAGE_SIZE).mapNotNull(::gif)
        val hasMore = page != null && page < MAX_PAGE && upstream.totalCount != null &&
            page.toLong() * PAGE_SIZE + upstream.entries.size < upstream.totalCount
        return GifResults(items, hasMore)
    }

    /** The entry as the contract has it, or null if it is not one: a missing or odd id, a size outside 1..4096. */
    fun gif(entry: UpstreamGif): GifSummary? {
        val id = entry.id?.takeIf { ID.matches(it) } ?: return null
        val width = entry.width?.takeIf { it in 1..MAX_SIZE } ?: return null
        val height = entry.height?.takeIf { it in 1..MAX_SIZE } ?: return null
        return GifSummary(id, title(entry.title), width, height)
    }

    /**
     * Plain text for a label: no control, format (bidi marks, zero-width characters), separator, private-use or unassigned
     * character and no lone surrogate; white space becomes one blank; at most [MAX_TITLE] characters (never half a surrogate pair).
     */
    fun title(raw: String?): String {
        val clean = StringBuilder()
        raw.orEmpty().codePoints().forEach { code ->
            when {
                Character.isWhitespace(code) || Character.isSpaceChar(code) -> clean.append(' ')
                !forbidden(code) -> clean.appendCodePoint(code)
            }
        }
        val text = clean.toString().replace(WHITESPACE, " ").trim()
        if (text.length <= MAX_TITLE) return text
        val end = if (Character.isHighSurrogate(text[MAX_TITLE - 1])) MAX_TITLE - 1 else MAX_TITLE
        return text.substring(0, end).trimEnd()
    }

    private fun forbidden(code: Int): Boolean = when (Character.getType(code).toByte()) {
        Character.CONTROL, Character.FORMAT, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR, Character.PRIVATE_USE,
        Character.SURROGATE, Character.UNASSIGNED,
        -> true
        else -> false
    }

    private fun invalid(field: String, constraint: String, message: String) =
        ValidationFailedException(listOf(InvalidField(field, constraint, message)))
}
