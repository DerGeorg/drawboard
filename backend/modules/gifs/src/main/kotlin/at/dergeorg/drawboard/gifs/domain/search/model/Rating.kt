package at.dergeorg.drawboard.gifs.domain.search.model

/**
 * The content rating of the instance (G6): the strictest GIPHY level is the default. `r` is not offered. It is configuration
 * only - no request parameter, no header, nothing the client says reaches it.
 */
enum class Rating(val wire: String) {
    G("g"),
    PG("pg"),
    PG_13("pg-13"),
    ;

    companion object {
        /** The rating named in [raw] (blank = [G]); anything else, `r` included, is a misconfiguration and stops the start. */
        fun parse(raw: String?): Rating {
            val text = raw?.trim()?.lowercase().orEmpty().ifEmpty { G.wire }
            return requireNotNull(entries.firstOrNull { it.wire == text }) { "DRAWBOARD_GIPHY_RATING must be g, pg or pg-13" }
        }
    }
}
