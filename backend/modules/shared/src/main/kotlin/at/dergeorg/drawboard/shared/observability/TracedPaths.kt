package at.dergeorg.drawboard.shared.observability

/**
 * Paths as traces and error log lines may show them. The card of a Magic placement or a Rotation estimate is masked: next to the
 * caller of the request (a guest's link, a seat's timing) it would say who placed or holds which card - what no answer of the
 * estimation sessions may say before REVIEW (Fable E2, backend review B1). Used by the HTTP server observation (`http.url`, core)
 * and the one log line per error response (`url.path`, api).
 */
object TracedPaths {

    const val MASK = "{itemId}"

    private val CARD_INPUT = Regex("(/estimation-sessions/[^/?#]+/items/)[^/?#]+(/(?:placement|estimate))")

    fun mask(path: String): String = CARD_INPUT.replace(path) { "${it.groupValues[1]}$MASK${it.groupValues[2]}" }
}
