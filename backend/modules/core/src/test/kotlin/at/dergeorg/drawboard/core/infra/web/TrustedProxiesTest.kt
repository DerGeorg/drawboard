package at.dergeorg.drawboard.core.infra.web

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.net.InetAddress
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TrustedProxiesTest {

    private fun ip(text: String) = InetAddress.getByName(text)

    @Nested
    inner class ClientOf {

        @Test
        fun `when no proxy is trusted then the socket address counts and X-Forwarded-For is ignored`() {
            val proxies = TrustedProxies(emptyList())

            assertEquals(ip("203.0.113.5"), proxies.clientOf(ip("203.0.113.5"), listOf("1.2.3.4")), "a client cannot name its own address")
        }

        @Test
        fun `when the peer is not a trusted proxy then its header is ignored`() {
            val proxies = TrustedProxies(listOf("10.0.0.0/8"))

            assertEquals(ip("203.0.113.5"), proxies.clientOf(ip("203.0.113.5"), listOf("10.1.1.1")), "untrusted peer")
        }

        @Test
        fun `when the peer is a trusted proxy then the rightmost entry that is not a trusted proxy is the client`() {
            val proxies = TrustedProxies(listOf("10.0.0.0/8", "192.168.1.1"))

            val client = proxies.clientOf(ip("10.0.0.2"), listOf("6.6.6.6, 203.0.113.5", "10.4.4.4, 192.168.1.1"))

            assertEquals(ip("203.0.113.5"), client, "spoofed 6.6.6.6 is to the left of the first untrusted entry from the right")
        }

        @Test
        fun `when every entry is a trusted proxy or there is no header then the peer is the answer`() {
            val proxies = TrustedProxies(listOf("10.0.0.0/8"))

            assertEquals(ip("10.0.0.2"), proxies.clientOf(ip("10.0.0.2"), listOf("10.9.9.9")), "all trusted")
            assertEquals(ip("10.0.0.2"), proxies.clientOf(ip("10.0.0.2"), emptyList()), "no header")
        }

        @Test
        fun `when an entry is no IP literal then the walk stops and the peer is the answer`() {
            val proxies = TrustedProxies(listOf("10.0.0.0/8"))

            assertEquals(ip("10.0.0.2"), proxies.clientOf(ip("10.0.0.2"), listOf("evil.example.org")), "host names are never resolved")
        }

        @Test
        fun `when IPv6 is used then blocks and entries work too`() {
            val proxies = TrustedProxies(listOf("fd00::/8"))

            assertEquals(ip("2001:db8::7"), proxies.clientOf(ip("fd00::2"), listOf("2001:db8::7")), "IPv6 client behind an IPv6 proxy")
        }
    }

    @Nested
    inner class Parsing {

        @Test
        fun `when a single address is given then it is a block of one`() {
            val proxies = TrustedProxies(listOf("172.18.0.5"))

            assertTrue(proxies.trusts(ip("172.18.0.5")), "the address")
            assertFalse(proxies.trusts(ip("172.18.0.6")), "its neighbour")
        }

        @Test
        fun `when an entry is malformed then startup fails with a message that names it`() {
            val failure = assertFailsWith<IllegalArgumentException>("garbage") { TrustedProxies(listOf("not-an-ip")) }
            assertTrue("not-an-ip" in failure.message.orEmpty(), "message names the entry")
            assertFailsWith<IllegalArgumentException>("prefix too long") { TrustedProxies(listOf("10.0.0.0/33")) }
        }
    }
}
