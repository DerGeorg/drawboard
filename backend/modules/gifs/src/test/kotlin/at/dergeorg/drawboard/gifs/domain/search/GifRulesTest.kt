package at.dergeorg.drawboard.gifs.domain.search

import at.dergeorg.drawboard.gifs.domain.search.model.GifSummary
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class GifRulesTest {

    @Nested
    inner class Term {

        @Test
        fun `when normalising a text then it is trimmed, collapsed and lower case`() {
            assertEquals("happy birthday dog", GifRules.term("  Happy \t Birthday  DOG\n"), "normalised search text")
        }

        @Test
        fun `when normalising a text of two characters after collapsing then it passes`() {
            assertEquals("ok", GifRules.term(" ok "), "the shortest text")
        }

        @ParameterizedTest(name = "[{index}]")
        @ValueSource(strings = ["", " ", "a", "  a  ", "\t\n"])
        fun `when normalising a text shorter than 2 characters after trimming then 400 VALIDATION_FAILED`(raw: String) {
            val error = assertFailsWith<ValidationFailedException>("too short") { GifRules.term(raw) }

            assertEquals(ErrorCode.VALIDATION_FAILED, error.errorCode, "error code")
            assertEquals("q", error.invalidFields.single().field, "the field")
        }

        @Test
        fun `when normalising a text of 51 characters then 400, 50 passes`() {
            assertEquals(50, GifRules.term("x".repeat(50)).length, "50 characters")
            assertFailsWith<ValidationFailedException>("51 characters") { GifRules.term("x".repeat(51)) }
        }

        @Test
        fun `when normalising a text with a control character then 400 and the text is not in the error`() {
            val error = assertFailsWith<ValidationFailedException>("control character") { GifRules.term("secret\u0007text") }

            assertEquals(false, error.message.orEmpty().contains("secret"), "the value is never echoed")
            assertEquals(false, error.invalidFields.any { it.message.contains("secret") }, "nor in a violation")
        }
    }

    @Nested
    inner class LangAndPage {

        @Test
        fun `when no language is given then en, a two-letter code passes, anything else is 400`() {
            assertEquals(listOf("en", "de"), listOf(GifRules.lang(null), GifRules.lang("de")), "default and given")
            listOf("DE", "deu", "d", "d1", "").forEach { raw ->
                assertFailsWith<ValidationFailedException>("language '$raw'") { GifRules.lang(raw) }
            }
        }

        @Test
        fun `when checking the page then 0 to 9 pass and everything else is 400`() {
            assertEquals(listOf(0, 9), listOf(GifRules.page(0), GifRules.page(9)), "the ends")
            listOf(-1, 10).forEach { raw -> assertFailsWith<ValidationFailedException>("page $raw") { GifRules.page(raw) } }
        }
    }

    @Nested
    inner class Entries {

        @Test
        fun `when an entry is valid then it is mapped to id, title, width and height`() {
            assertEquals(GifSummary("abc123", "A cat", 480, 270), GifRules.gif(entry()), "the GIF")
        }

        @ParameterizedTest(name = "id [{0}]")
        @ValueSource(strings = ["", "a/b", "a b", "a-b", "../x", "a?b=c", "abc\n", "ä"])
        fun `when an entry has an id outside the pattern then it is dropped`(id: String) {
            assertNull(GifRules.gif(entry(id = id)), "an id that could change the image address")
        }

        @Test
        fun `when an entry has an id of 65 characters then it is dropped, 64 passes`() {
            assertNull(GifRules.gif(entry(id = "a".repeat(65))), "65 characters")
            assertEquals("a".repeat(64), GifRules.gif(entry(id = "a".repeat(64)))?.id, "64 characters")
        }

        @Test
        fun `when an entry has a size outside 1 to 4096 or none then it is dropped`() {
            listOf(entry(width = 0), entry(width = 4097), entry(height = 0), entry(height = -3), entry(width = null), entry(height = null))
                .forEach { assertNull(GifRules.gif(it), "size of $it") }
            assertEquals(4096 to 1, GifRules.gif(entry(width = 4096, height = 1))?.let { it.width to it.height }, "the ends pass")
        }

        @Test
        fun `when an entry has no id then it is dropped`() {
            assertNull(GifRules.gif(entry().copy(id = null)), "no id")
        }

        @Test
        fun `when an entry has no title then the title is empty`() {
            assertEquals("", GifRules.gif(entry(title = null))?.title, "a title may be empty")
        }
    }

    @Nested
    inner class Title {

        @Test
        fun `when a title has control and bidi characters then they are removed`() {
            val raw = "a\u0000b\u0007c‮d‬e⁦f⁩g‏h​i﻿j­k"

            assertEquals("abcdefghijk", GifRules.title(raw), "no control, no bidi mark, no zero-width character, no soft hyphen")
        }

        @Test
        fun `when a title has line breaks and runs of blanks then they become one blank`() {
            assertEquals("a b c", GifRules.title("  a \n\n b\t\tc   "), "plain, one line")
        }

        @Test
        fun `when a title holds markup then it stays text - nothing is interpreted, the client renders text only`() {
            assertEquals("<b>x</b> & y", GifRules.title("<b>x</b> & y"), "no escaping here: the contract says plain text")
        }

        @Test
        fun `when a title is longer than 200 characters then it is cut at 200`() {
            assertEquals(200, GifRules.title("x".repeat(500)).length, "200 characters")
        }

        @Test
        fun `when the cut would split a surrogate pair then the pair goes entirely`() {
            val title = GifRules.title("x".repeat(199) + "😀" + "tail")

            assertEquals("x".repeat(199), title, "no half of an emoji")
        }

        @Test
        fun `when a title has a lone surrogate then it is removed, a whole emoji stays`() {
            assertEquals("a😀b", GifRules.title("a😀\uD83Db"), "the emoji stays, the lone half goes")
        }

        @Test
        fun `when a title is null then it is empty`() {
            assertEquals("", GifRules.title(null), "no title")
        }
    }

    @Nested
    inner class Results {

        @Test
        fun `when GIPHY sends valid and invalid entries then the invalid ones are dropped and the others keep their order`() {
            val upstream = page(entry("a1"), entry("b/2"), entry("c3", width = 0), entry("d4"), total = 4)

            val results = GifRules.results(upstream, page = 0)

            assertEquals(listOf("a1", "d4"), results.items.map { it.id }, "valid entries")
        }

        @Test
        fun `when GIPHY sends more than 24 entries then 24 are used`() {
            val upstream = page(*Array(30) { entry("id$it") }, total = 100)

            assertEquals(24, GifRules.results(upstream, page = 0).items.size, "a page is 24")
        }

        @Test
        fun `when there are more results than the pages so far then hasMore, otherwise not`() {
            val twentyFour = page(*Array(24) { entry("id$it") }, total = 50)

            assertEquals(true, GifRules.results(twentyFour, page = 0).hasMore, "24 of 50 on page 0")
            assertEquals(true, GifRules.results(twentyFour, page = 1).hasMore, "48 of 50 on page 1")
            assertEquals(false, GifRules.results(page(entry(), entry("b2"), total = 50), page = 2).hasMore, "48 + 2 of 50: the last page")
            assertEquals(false, GifRules.results(page(entry(), total = null), page = 0).hasMore, "no total: no more")
        }

        @Test
        fun `when the page is 9 then hasMore is false, however many results there are`() {
            val upstream = page(*Array(24) { entry("id$it") }, total = 100_000)

            assertEquals(false, GifRules.results(upstream, page = 9).hasMore, "page 9 is the last one the contract allows")
        }

        @Test
        fun `when listing trending then hasMore is false`() {
            val upstream = page(*Array(24) { entry("id$it") }, total = 100_000)

            assertEquals(false, GifRules.results(upstream, page = null).hasMore, "trending has no paging")
        }
    }
}
