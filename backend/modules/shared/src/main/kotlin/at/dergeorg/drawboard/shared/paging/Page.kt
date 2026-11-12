package at.dergeorg.drawboard.shared.paging

/** Which page of a result to read. [number] is zero-based. Upper limits for [size] are the caller's contract. */
data class PageQuery(val number: Int, val size: Int) {
    init {
        require(number >= 0) { "page number must be >= 0, was $number" }
        require(size >= 1) { "page size must be >= 1, was $size" }
    }

    val offset: Long get() = number.toLong() * size
}

/** One page of a result plus its position in the whole result. */
data class Page<out T>(val items: List<T>, val query: PageQuery, val totalElements: Long) {
    val totalPages: Int get() = ((totalElements + query.size - 1) / query.size).toInt()

    fun <R> map(transform: (T) -> R): Page<R> = Page(items.map(transform), query, totalElements)
}
