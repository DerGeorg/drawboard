package at.dergeorg.drawboard.core.infra.web

import java.net.InetAddress
import java.net.UnknownHostException

/**
 * The proxies whose `X-Forwarded-For` header may be believed (S7.3). A list of IP addresses or CIDR blocks
 * (`10.0.0.0/8`, `172.18.0.5`, `fd00::/8`); empty (the default) means no proxy is trusted: the socket address counts and
 * the header is ignored - a client must not be able to name its own address.
 */
internal class TrustedProxies(entries: List<String>) {

    private class Block(val network: ByteArray, val prefixBits: Int)

    private val blocks: List<Block> = entries.map { it.trim() }.filter { it.isNotEmpty() }.map(::parse)

    val isEmpty: Boolean get() = blocks.isEmpty()

    fun trusts(address: InetAddress): Boolean = blocks.any { contains(it, address.address) }

    /**
     * The client behind [peer]: [peer] itself unless it is trusted; otherwise the rightmost entry of [forwardedFor]
     * (all values of the header, in order) that is not trusted. An entry that is no IP literal ends the walk and the
     * answer is [peer] - the header is garbage then, and fail-safe is the address we can see.
     */
    fun clientOf(peer: InetAddress, forwardedFor: List<String>): InetAddress {
        if (!trusts(peer)) return peer
        val entries = forwardedFor.flatMap { it.split(',') }.map { it.trim() }.filter { it.isNotEmpty() }
        for (entry in entries.asReversed()) {
            val address = literal(entry) ?: return peer
            if (!trusts(address)) return address
        }
        return peer
    }

    private fun parse(entry: String): Block {
        val parts = entry.split('/')
        require(parts.size <= 2) { "DRAWBOARD_TRUSTED_PROXIES: '$entry' is neither an address nor a CIDR block" }
        val address = literal(parts[0]) ?: throw IllegalArgumentException("DRAWBOARD_TRUSTED_PROXIES: '$entry' is not an IP address")
        val bits = address.address.size * BYTE_BITS
        val prefix = parts.getOrNull(1)?.toIntOrNull() ?: if (parts.size == 1) bits else null
        require(prefix != null && prefix in 0..bits) { "DRAWBOARD_TRUSTED_PROXIES: '$entry' has an invalid prefix length" }
        return Block(address.address, prefix)
    }

    private fun contains(block: Block, candidate: ByteArray): Boolean {
        if (block.network.size != candidate.size) return false
        var remaining = block.prefixBits
        for (i in candidate.indices) {
            if (remaining <= 0) break
            val bits = minOf(remaining, BYTE_BITS)
            val mask = (BYTE_MASK shl (BYTE_BITS - bits)) and BYTE_MASK
            if ((candidate[i].toInt() and mask) != (block.network[i].toInt() and mask)) return false
            remaining -= bits
        }
        return true
    }

    /** An IP literal only - never a host name (that would be a DNS lookup on user input). */
    private fun literal(text: String): InetAddress? {
        val plausible = text.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == '.' || it == ':' }
        if (!plausible || text.isEmpty()) return null
        return try {
            InetAddress.getByName(text)
        } catch (_: UnknownHostException) {
            null
        }
    }

    private companion object {
        const val BYTE_BITS = 8
        const val BYTE_MASK = 0xff
    }
}
