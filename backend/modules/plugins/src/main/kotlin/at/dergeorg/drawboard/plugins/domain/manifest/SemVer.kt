package at.dergeorg.drawboard.plugins.domain.manifest

/**
 * A Semantic Versioning 2.0.0 version, with the precedence rules of the specification (build metadata is ignored, a
 * release is higher than its pre-releases, numeric identifiers compare as numbers). Used for the upgrade rule
 * ("a higher version of an installed id is an upgrade") and for `minHostVersion`.
 */
internal class SemVer private constructor(
    val major: Long,
    val minor: Long,
    val patch: Long,
    private val preRelease: List<String>,
) : Comparable<SemVer> {

    override fun compareTo(other: SemVer): Int {
        val core = compareValuesBy(this, other, { it.major }, { it.minor }, { it.patch })
        return if (core != 0) core else comparePreRelease(other)
    }

    /** A release is higher than its pre-releases; otherwise identifier by identifier, a longer list wins a tie. */
    private fun comparePreRelease(other: SemVer): Int {
        if (preRelease.isEmpty() || other.preRelease.isEmpty()) return other.preRelease.size.compareTo(preRelease.size)
        val firstDifference = preRelease.zip(other.preRelease).map { (a, b) -> compareIdentifier(a, b) }.firstOrNull { it != 0 }
        return firstDifference ?: preRelease.size.compareTo(other.preRelease.size)
    }

    override fun equals(other: Any?) = other is SemVer && compareTo(other) == 0

    override fun hashCode() = listOf(major, minor, patch, preRelease).hashCode()

    private fun compareIdentifier(a: String, b: String): Int {
        val aNumber = a.all { it.isDigit() }
        val bNumber = b.all { it.isDigit() }
        return when {
            aNumber && bNumber -> compareValues(a.toBigInteger(), b.toBigInteger())
            aNumber -> -1
            bNumber -> 1
            else -> a.compareTo(b)
        }
    }

    companion object {
        const val MAX_LENGTH = 64

        /** The pattern of the manifest schema (docs/plugin-protocol.md, `$defs.semver`). */
        val PATTERN = Regex(
            "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$",
        )

        /** Null when [text] is not a version of the manifest schema (or its numbers do not fit a long). */
        fun parseOrNull(text: String): SemVer? {
            if (text.length > MAX_LENGTH || !PATTERN.matches(text)) return null
            val core = text.substringBefore('+').substringBefore('-')
            val numbers = core.split('.').map { it.toLongOrNull() ?: return null }
            val pre = text.substringBefore('+').substringAfter('-', "").takeIf { it.isNotEmpty() }?.split('.').orEmpty()
            // numeric pre-release identifiers must not have leading zeros (the pattern does not exclude them)
            if (pre.any { it.length > 1 && it.all(Char::isDigit) && it.startsWith('0') }) return null
            return SemVer(numbers[0], numbers[1], numbers[2], pre)
        }
    }
}
