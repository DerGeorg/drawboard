package at.dergeorg.drawboard.api.common

/**
 * The display name of a guest (S1.3, S1.10): whatever the visitor typed, made harmless. Control and format characters
 * (including right-to-left overrides and zero-width joiners), line breaks and tabs are removed, runs of blanks collapse
 * to one space, the result is trimmed and cut at 64 characters. null if nothing is left.
 */
internal object GuestNames {

    const val MAX_LENGTH = 64

    fun sanitize(raw: String?): String? {
        if (raw == null) return null
        val cleaned = StringBuilder()
        var lastWasSpace = true
        raw.codePoints().forEach { cp ->
            val blank = Character.isWhitespace(cp) || Character.getType(cp) == Character.SPACE_SEPARATOR.toInt()
            val invisible = Character.isISOControl(cp) || Character.getType(cp) in INVISIBLE
            when {
                blank -> if (!lastWasSpace) cleaned.append(' ').also { lastWasSpace = true }
                invisible -> Unit
                else -> cleaned.appendCodePoint(cp).also { lastWasSpace = false }
            }
        }
        return cut(cleaned.toString().trim(), MAX_LENGTH).takeIf { it.isNotEmpty() }
    }

    /** At most [max] characters (code points - an emoji is one), never in the middle of a pair. */
    private fun cut(text: String, max: Int): String =
        if (text.codePointCount(0, text.length) <= max) text else text.substring(0, text.offsetByCodePoints(0, max)).trimEnd()

    /** What is appended when a guest's name equals the name of a registered user: a guest cannot pass as one (S1.10). */
    const val GUEST_SUFFIX = " (guest)"

    /** Appends the suffix, keeping the whole name within the limit. */
    fun asGuest(name: String): String = cut(name, MAX_LENGTH - GUEST_SUFFIX.length) + GUEST_SUFFIX

    private val INVISIBLE = setOf(
        Character.CONTROL.toInt(),
        Character.FORMAT.toInt(),
        Character.LINE_SEPARATOR.toInt(),
        Character.PARAGRAPH_SEPARATOR.toInt(),
        Character.PRIVATE_USE.toInt(),
        Character.UNASSIGNED.toInt(),
        Character.SURROGATE.toInt(), // only a lone surrogate reaches here: pairs are one code point
    )
}
