package at.dergeorg.drawboard.shared.security

import java.net.InetAddress
import java.net.UnknownHostException

/**
 * The key a per-address rate limit counts under (S7.3). An IPv4 address is its own key. An IPv6 address is cut to its
 * /64 prefix: one subscriber usually owns a whole /64, so counting full addresses would let one client mint endless
 * "different" addresses. Anything that is not an IP literal (`unknown`) is kept as it is - a host name is never resolved.
 */
object IpBuckets {

    @Suppress("ReturnCount") // a chain of "this is not an IPv6 literal" exits
    fun of(address: String): String {
        val plausible = address.isNotEmpty() && address.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it in ".:%" }
        if (!plausible || ':' !in address) return address
        val parsed = try {
            InetAddress.getByName(address.substringBefore('%'))
        } catch (_: UnknownHostException) {
            return address
        }
        val bytes = parsed.address
        if (bytes.size != IPV6_BYTES) return parsed.hostAddress // IPv4-mapped IPv6 is an IPv4 address
        return "v6:" + bytes.take(PREFIX_BYTES).joinToString("") { "%02x".format(it) } + "/64"
    }

    private const val IPV6_BYTES = 16
    private const val PREFIX_BYTES = 8
}
