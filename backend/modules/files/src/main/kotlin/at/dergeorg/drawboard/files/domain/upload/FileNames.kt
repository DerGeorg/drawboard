package at.dergeorg.drawboard.files.domain.upload

/** Makes the name a client sent fit for the database and a `Content-Disposition` header (S4.2). It is never a path. */
internal object FileNames {

    const val MAX_LENGTH = 255
    private const val FALLBACK = "file"
    private val BIDI_CONTROLS = ('‪'..'‮').toSet() + ('⁦'..'⁩').toSet() + setOf('‎', '‏')

    fun sanitise(submitted: String?): String {
        val last = submitted.orEmpty().substringAfterLast('/').substringAfterLast('\\')
        val cleaned = last.filterNot { it.isISOControl() || it in BIDI_CONTROLS || it == '"' }.trim().trim('.').trim()
        if (cleaned.isEmpty()) return FALLBACK
        if (cleaned.length <= MAX_LENGTH) return cleaned
        // too long: shorten the part before the extension, so the extension still fits the type
        val extension = cleaned.substringAfterLast(
            '.',
            "",
        ).takeIf { it.isNotEmpty() && it.length < MAX_EXTENSION }?.let { ".$it" }.orEmpty()
        return cleaned.take(MAX_LENGTH - extension.length) + extension
    }

    private const val MAX_EXTENSION = 16
}
