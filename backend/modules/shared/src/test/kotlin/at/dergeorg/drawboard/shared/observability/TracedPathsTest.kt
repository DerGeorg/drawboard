package at.dergeorg.drawboard.shared.observability

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class TracedPathsTest {

    private val prefix = "/api/boards/b1/estimation-sessions/s1/items"

    @Test
    fun `when a placement or an estimate is traced then the card is masked, the board and the session stay`() {
        assertEquals("$prefix/{itemId}/placement", TracedPaths.mask("$prefix/0199-card/placement"), "placement")
        assertEquals("http://localhost:8080$prefix/{itemId}/estimate?x=1", TracedPaths.mask("http://localhost:8080$prefix/c2/estimate?x=1"),
            "estimate, as a full URL")
    }

    @Test
    fun `when another path is traced then it stays as it is`() {
        listOf("$prefix/c3/decision", "/api/boards/b1/poker-rounds/r1/vote", "/api/boards/b1/estimation-sessions/s1").forEach {
            assertEquals(it, TracedPaths.mask(it), it)
        }
    }
}
