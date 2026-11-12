package at.dergeorg.drawboard.files.domain.ranges

import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import kotlin.test.assertEquals

class RangeParserTest {

    private val size = 1000L

    @Test
    fun `when there is no range header then the whole file is served`() {
        assertEquals(RangeRequest.Whole, RangeParser.parse(null, size), "no header")
    }

    @Test
    fun `when the range is closed, open or a suffix then it is cut to the file`() {
        assertEquals(RangeRequest.Partial(0, 99), RangeParser.parse("bytes=0-99", size), "closed")
        assertEquals(RangeRequest.Partial(900, 999), RangeParser.parse("bytes=900-", size), "open")
        assertEquals(RangeRequest.Partial(900, 999), RangeParser.parse("bytes=-100", size), "suffix")
        assertEquals(
            RangeRequest.Partial(0, 999),
            RangeParser.parse("bytes=-5000", size),
            "a suffix longer than the file is the whole file",
        )
        assertEquals(RangeRequest.Partial(500, 999), RangeParser.parse("bytes=500-5000", size), "an end behind the file is cut")
        assertEquals(RangeRequest.Partial(999, 999), RangeParser.parse("bytes=999-999", size), "the last byte")
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(
        strings = [
            "bytes=0-1,5-6", "bytes=1000-", "bytes=1500-1600", "bytes=5-1", "bytes=-0", "bytes=-", "bytes=", "bytes=a-b", "bytes=1-b",
            "items=0-5", "0-5", "bytes=0-5-7", "bytes=-1-2", "bytes=+1-2", "bytes= 1 - 2 x",
        ],
    )
    fun `when the range cannot be served then it is not satisfiable`(header: String) {
        assertEquals(RangeRequest.NotSatisfiable, RangeParser.parse(header, size), "header $header")
    }

    @Test
    fun `when the file is empty then any range is not satisfiable`() {
        assertEquals(RangeRequest.NotSatisfiable, RangeParser.parse("bytes=0-0", 0), "empty file")
    }

    @Test
    fun `when the numbers overflow a long then the range is not satisfiable instead of failing`() {
        assertEquals(RangeRequest.NotSatisfiable, RangeParser.parse("bytes=99999999999999999999-", size), "overflow")
    }
}
