package at.dergeorg.drawboard.plugins.domain.plugins

/** The media type a bundle file is served with - derived from the extension only, never from content. */
internal object PluginAssets {

    const val FRAME_PATH = "__drawboard/frame.html"

    fun mediaTypeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        // text and markdown are shown as plain text, never rendered
        else -> "text/plain; charset=utf-8"
    }
}
