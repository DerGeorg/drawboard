package at.dergeorg.drawboard.files.domain.ranges

/** The outcome of reading a `Range` header against a file of known size (S4.7). */
internal sealed interface RangeRequest {
    /** No `Range` header: the whole file. */
    data object Whole : RangeRequest

    /** One valid range, both ends inclusive and inside the file. */
    data class Partial(val first: Long, val last: Long) : RangeRequest {
        val length: Long get() = last - first + 1
    }

    /** More than one range, a malformed header, or a range outside the file: 416. */
    data object NotSatisfiable : RangeRequest
}

/**
 * ONE byte range per request (S4.7): `bytes=a-b`, `bytes=a-`, `bytes=-n`. A header with several ranges, a unit other
 * than `bytes`, a malformed value or a range that starts behind the end of the file is [RangeRequest.NotSatisfiable]
 * - the contract answers all of them with 416, none is guessed at. An end behind the file is cut to the last byte.
 */
internal object RangeParser {

    private const val UNIT = "bytes="

    fun parse(header: String?, size: Long): RangeRequest {
        if (header == null) return RangeRequest.Whole
        val value = header.trim()
        val spec = value.removePrefix(UNIT).trim()
        val dash = spec.indexOf('-')
        val usable = value.startsWith(UNIT) && ',' !in value && dash >= 0 && size > 0
        return if (usable) parseSpec(spec.substring(0, dash).trim(), spec.substring(dash + 1).trim(), size) else RangeRequest.NotSatisfiable
    }

    private fun parseSpec(from: String, to: String, size: Long): RangeRequest {
        val numeric = (from.isNotEmpty() || to.isNotEmpty()) && from.all { it in '0'..'9' } && to.all { it in '0'..'9' }
        if (!numeric) return RangeRequest.NotSatisfiable
        return if (from.isEmpty()) suffix(to, size) else bounded(from, to, size)
    }

    /** `bytes=-n`: the last n bytes. */
    private fun suffix(count: String, size: Long): RangeRequest {
        val n = count.toLongOrNull() ?: return RangeRequest.NotSatisfiable
        return if (n <= 0) RangeRequest.NotSatisfiable else RangeRequest.Partial((size - n).coerceAtLeast(0), size - 1)
    }

    /** `bytes=a-b` and `bytes=a-`. */
    private fun bounded(from: String, to: String, size: Long): RangeRequest {
        val first = from.toLongOrNull()
        val last = if (to.isEmpty()) size - 1 else to.toLongOrNull()
        val valid = first != null && last != null && last >= first && first < size
        return if (valid) RangeRequest.Partial(first, minOf(last, size - 1)) else RangeRequest.NotSatisfiable
    }
}
