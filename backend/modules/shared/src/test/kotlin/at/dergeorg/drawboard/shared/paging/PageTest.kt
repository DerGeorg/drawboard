package at.dergeorg.drawboard.shared.paging

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PageTest {

    @Nested
    inner class TotalPages {

        @Test
        fun `when the elements fill the last page exactly then there is no extra page`() {
            val page = Page(items = emptyList<Int>(), query = PageQuery(number = 0, size = 10), totalElements = 20)

            assertEquals(2, page.totalPages, "20 elements in pages of 10")
        }

        @Test
        fun `when the last page is partly filled then it still counts`() {
            val page = Page(items = emptyList<Int>(), query = PageQuery(number = 0, size = 10), totalElements = 21)

            assertEquals(3, page.totalPages, "21 elements in pages of 10")
        }

        @Test
        fun `when there are no elements then there are no pages`() {
            val page = Page(items = emptyList<Int>(), query = PageQuery(number = 0, size = 10), totalElements = 0)

            assertEquals(0, page.totalPages, "an empty result has zero pages")
        }
    }

    @Nested
    inner class Query {

        @Test
        fun `when asking for page 3 of size 20 then the offset skips 60 elements`() {
            assertEquals(60L, PageQuery(number = 3, size = 20).offset, "offset of page 3")
        }

        @Test
        fun `when the page size is zero then the query is rejected`() {
            assertFailsWith<IllegalArgumentException>("a page must hold at least one element") {
                PageQuery(number = 0, size = 0)
            }
        }
    }
}
