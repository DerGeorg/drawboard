package at.dergeorg.drawboard.shared.security

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class IpBucketsTest {

    @Test
    fun `when the address is IPv4 then it is its own key`() {
        assertEquals("203.0.113.5", IpBuckets.of("203.0.113.5"), "IPv4")
    }

    @Test
    fun `when two IPv6 addresses share a 64 bit prefix then they share a key, another prefix does not`() {
        val a = IpBuckets.of("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
        val b = IpBuckets.of("2001:db8:1:2::1")
        val other = IpBuckets.of("2001:db8:1:3::1")

        assertEquals(a, b, "same /64")
        assertNotEquals(a, other, "different /64")
    }

    @Test
    fun `when the address is an IPv4-mapped IPv6 address then it is the IPv4 key`() {
        assertEquals("203.0.113.5", IpBuckets.of("::ffff:203.0.113.5"), "mapped")
    }

    @Test
    fun `when it is no IP literal then it stays as it is and nothing is resolved`() {
        assertEquals("unknown", IpBuckets.of("unknown"), "unknown")
        assertEquals("evil.example.org:80", IpBuckets.of("evil.example.org:80"), "host name")
    }
}
