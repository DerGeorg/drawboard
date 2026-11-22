package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Instant

/**
 * What the cache is keyed by (G7): the kind of call, the normalised search text, the page, the instance rating and the language.
 * The text is the search of a user, so [toString] leaves it out.
 */
internal data class CacheKey(val trending: Boolean, val term: String, val page: Int, val rating: Rating, val lang: String) {
    override fun toString(): String = "CacheKey"
}

/**
 * Answers for a while, at most [maxEntries] of them, in memory (one replica, like the rest). The entry that was read longest ago goes
 * first; an entry past its time is never returned. Time comes from the application clock, so tests move it.
 */
internal class GifCache<V : Any>(private val clock: Clock, private val maxEntries: Int) {

    private class Entry<V>(val value: V, val expires: Instant)

    private val entries = object : LinkedHashMap<CacheKey, Entry<V>>(INITIAL_CAPACITY, LOAD_FACTOR, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<CacheKey, Entry<V>>): Boolean = size > maxEntries
    }

    @Synchronized
    fun get(key: CacheKey): V? {
        val entry = entries[key] ?: return null
        if (clock.now() < entry.expires) return entry.value
        entries.remove(key)
        return null
    }

    @Synchronized
    fun put(key: CacheKey, value: V, ttl: Duration) {
        val now = clock.now()
        if (entries.size >= maxEntries) entries.values.removeIf { it.expires <= now } // the dead go before the living
        entries[key] = Entry(value, now + ttl)
    }

    @Synchronized
    fun size(): Int = entries.size

    private companion object {
        const val INITIAL_CAPACITY = 16
        const val LOAD_FACTOR = 0.75f
    }
}
