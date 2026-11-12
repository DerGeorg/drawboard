package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.testing.version
import org.junit.jupiter.api.Test
import kotlin.uuid.Uuid
import kotlin.test.assertEquals

class RequestIdsTest {

    private val traceId = "4bf92f3577b34da6a3ce929d0e0e4736"

    @Test
    fun `when the caller sends a valid request id then it is kept`() {
        assertEquals("frontend-4711-abc", RequestIds.resolve("frontend-4711-abc", traceId), "inbound request id")
    }

    @Test
    fun `when the caller sends no request id then the trace id is used`() {
        assertEquals(traceId, RequestIds.resolve(null, traceId), "request id without inbound header")
    }

    @Test
    fun `when the inbound request id could inject into logs or headers then the trace id is used`() {
        assertEquals(traceId, RequestIds.resolve("abc\r\nSet-Cookie: x=1", traceId), "request id for a malicious header value")
    }

    @Test
    fun `when the inbound request id is too short then the trace id is used`() {
        assertEquals(traceId, RequestIds.resolve("abc", traceId), "request id for a 3 character header")
    }

    @Test
    fun `when there is neither a request id nor a valid trace id then a random Uuid is used`() {
        val requestId = RequestIds.resolve(null, "00000000000000000000000000000000")

        assertEquals(4, Uuid.parse(requestId).version(), "fallback request id is a random Uuid")
    }
}
