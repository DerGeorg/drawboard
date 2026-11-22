package at.dergeorg.drawboard.gifs.domain.search.model

import kotlin.uuid.Uuid

/** One GIF the picker may show: the id at GIPHY, a plain-text title and the size of the original (only for the aspect ratio). */
data class GifSummary(val id: String, val title: String, val width: Int, val height: Int)

/** One page of results; [hasMore] is false on the last page GIPHY has and always on the last page the contract allows. */
data class GifResults(val items: List<GifSummary>, val hasMore: Boolean)

/**
 * A search of [userId]. [q] and [lang] are what the caller sent; the use case trims, collapses and checks them. The search text
 * is private to the user: [toString] leaves it out, so no log line or exception message that prints a command can leak it (G8).
 */
data class SearchGifsCommand(val userId: Uuid, val q: String, val page: Int = 0, val lang: String? = null) {
    override fun toString(): String = "SearchGifsCommand(page=$page)"
}
