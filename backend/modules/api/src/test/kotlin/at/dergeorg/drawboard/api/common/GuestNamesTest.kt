package at.dergeorg.drawboard.api.common

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GuestNamesTest {

    @Test
    fun `when sanitising then blanks collapse and the ends are trimmed`() {
        assertEquals("Gus Guest", GuestNames.sanitize("  Gus \t  Guest\n"), "collapsed")
    }

    @Test
    fun `when sanitising then control, format and bidi characters are removed`() {
        assertEquals("Eve", GuestNames.sanitize("E‮v​e\u0007\u0000"), "no override, no zero width, no bell, no NUL")
    }

    @Test
    fun `when nothing is left then null`() {
        assertNull(GuestNames.sanitize("​‮ \n"), "only invisible characters")
        assertNull(GuestNames.sanitize(null), "no name")
    }

    @Test
    fun `when the name is longer than 64 characters then it is cut, an emoji counting as one`() {
        val name = GuestNames.sanitize("a".repeat(63) + "😀😀")!!

        assertEquals(64, name.codePointCount(0, name.length), "64 characters")
        assertEquals(true, name.endsWith("😀"), "a pair is never cut in the middle")
    }

    @Test
    fun `when marking a guest as a guest then the suffix fits into the limit`() {
        val marked = GuestNames.asGuest("x".repeat(64))

        assertEquals(64, marked.length, "still at most 64")
        assertEquals(true, marked.endsWith(" (guest)"), "suffix")
    }
}
