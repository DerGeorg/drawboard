package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.Rating
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class GifCacheTest {

    private val clock = MutableClock()

    private fun key(term: String, page: Int = 0, rating: Rating = Rating.G, lang: String = "en") =
        CacheKey(trending = false, term = term, page = page, rating = rating, lang = lang)

    @Test
    fun `when an entry is younger than its time then it is returned, older then it is gone`() {
        val cache = GifCache<String>(clock, 10)
        cache.put(key("cat"), "cats", 15.minutes)

        clock.advanceBy(14.minutes + 59.seconds)
        val young = cache.get(key("cat"))
        clock.advanceBy(2.seconds)

        assertEquals("cats" to null, young to cache.get(key("cat")), "alive after 14:59, gone after 15:01")
        assertEquals(0, cache.size(), "an expired entry is removed when it is looked at")
    }

    @Test
    fun `when two keys differ in text, page, rating or language then they are two entries`() {
        val cache = GifCache<String>(clock, 10)
        val keys = listOf(key("cat"), key("dog"), key("cat", page = 1), key("cat", rating = Rating.PG), key("cat", lang = "de"))
        keys.forEachIndexed { index, key -> cache.put(key, "v$index", 1.minutes) }

        assertEquals(keys.indices.map { "v$it" }, keys.map { cache.get(it) }, "every part of the key counts (G7)")
    }

    @Test
    fun `when there are more than the maximum entries then the one read longest ago goes first`() {
        val cache = GifCache<String>(clock, 3)
        listOf("a", "b", "c").forEach { cache.put(key(it), it, 1.minutes) }
        cache.get(key("a")) // a is fresh again, b is the oldest now

        cache.put(key("d"), "d", 1.minutes)

        assertEquals(listOf("a", null, "c", "d"), listOf("a", "b", "c", "d").map { cache.get(key(it)) }, "b was evicted")
        assertEquals(3, cache.size(), "never more than 3")
    }

    @Test
    fun `when the cache is full and some entries are dead then the dead ones go before a living one`() {
        val cache = GifCache<String>(clock, 2)
        cache.put(key("short"), "s", 10.seconds)
        cache.put(key("long"), "l", 10.minutes)
        clock.advanceBy(1.minutes)

        cache.put(key("new"), "n", 10.minutes)

        assertEquals(listOf(null, "l", "n"), listOf("short", "long", "new").map { cache.get(key(it)) }, "only the dead one is gone")
    }

    @Test
    fun `when a key is printed then it does not show the search text`() {
        assertEquals(false, key("my secret search").toString().contains("secret"), "G8: no search text in any printed form")
        assertNull(GifCache<String>(clock, 1).get(key("none")), "an empty cache has nothing")
    }
}
