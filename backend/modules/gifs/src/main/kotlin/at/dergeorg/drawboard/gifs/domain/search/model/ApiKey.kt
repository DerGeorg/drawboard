package at.dergeorg.drawboard.gifs.domain.search.model

/**
 * The GIPHY API key of this instance (G1, G2). GIPHY takes it as a query parameter, so it must never end up in a log line,
 * a span, a metric, an audit event or an error body: the only way to the text is [reveal], called by the GIPHY adapter and
 * nowhere else, and [toString] says nothing. The class is not a data class on purpose (no generated `toString`, `copy`, `equals`).
 */
class ApiKey private constructor(private val value: String) {

    /** The key as GIPHY wants it. Only the adapter that talks to GIPHY calls this. */
    fun reveal(): String = value

    override fun toString(): String = "ApiKey(redacted)"

    companion object {
        private val SHAPE = Regex("[A-Za-z0-9]{16,64}")

        /**
         * The key in [raw] (a variable or the content of a secret file, surrounding whitespace ignored): null if there is none
         * (null or blank = GIF search is off), the key if it has the shape of a GIPHY key. A key of another shape is a
         * misconfiguration and stops the start; the message never contains the value.
         */
        fun parse(raw: String?): ApiKey? {
            val text = raw?.trim().orEmpty()
            if (text.isEmpty()) return null
            require(SHAPE.matches(text)) { "the GIPHY API key must consist of 16 to 64 letters and digits" }
            return ApiKey(text)
        }
    }
}
