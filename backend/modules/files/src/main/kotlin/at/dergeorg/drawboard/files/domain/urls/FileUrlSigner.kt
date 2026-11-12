package at.dergeorg.drawboard.files.domain.urls

import at.dergeorg.drawboard.files.domain.files.model.FileVariant
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Signs and verifies the file URLs (S4.4, the format of `FileUrl` in the contract):
 *
 *     /files/{fileId}?v=<variant>&exp=<unix seconds>&sig=base64url(HMAC-SHA256(key, fileId|v|exp))
 *
 * [keys] come from `DRAWBOARD_FILE_URL_KEYS`, each at least [MIN_KEY_BYTES] bytes: the FIRST signs, EVERY key verifies
 * (rotation: put the new key first, drop the old one after [lifetime]). The signature is not bound to an IP and not to a
 * user - the URL is a secret and is treated like one. Verification rejects an `exp` in the past and one further ahead
 * than [lifetime] plus [CLOCK_SKEW] (a leaked key must not be able to mint URLs that live for a year), and compares in
 * constant time against every key, without stopping at the first hit.
 */
internal class FileUrlSigner(
    private val keys: List<ByteArray>,
    private val clock: Clock,
    val lifetime: Duration = 1.hours,
) {
    init {
        require(keys.isNotEmpty()) { "DRAWBOARD_FILE_URL_KEYS must hold at least one key" }
        require(keys.all { it.size >= MIN_KEY_BYTES }) { "DRAWBOARD_FILE_URL_KEYS: every key needs at least $MIN_KEY_BYTES bytes" }
        require(lifetime.isPositive() && lifetime <= MAX_LIFETIME) { "file URLs live at most $MAX_LIFETIME" }
    }

    /** The expiry a URL issued now gets. */
    fun expiry(now: Instant = clock.now()): Instant = now + lifetime

    /** The signed relative URL of [variant] of [fileId], valid until [expiresAt]. */
    fun url(fileId: Uuid, variant: FileVariant, expiresAt: Instant): String {
        val exp = expiresAt.epochSeconds
        return "/files/$fileId?v=${variant.wire}&exp=$exp&sig=${sign(keys.first(), fileId, variant.wire, exp)}"
    }

    /** Whether [signature] is valid for these parameters now. Never throws for bad input. */
    fun verify(fileId: Uuid, variant: String, exp: Long, signature: String): Boolean {
        val now = clock.now().epochSeconds
        if (exp < now || exp > now + lifetime.inWholeSeconds + CLOCK_SKEW.inWholeSeconds) return false
        val provided = try {
            Base64.getUrlDecoder().decode(signature)
        } catch (_: IllegalArgumentException) {
            return false
        }
        // every key is tried, so the time does not tell which one (or whether any) matched
        var valid = false
        for (key in keys) {
            val expected = Base64.getUrlDecoder().decode(sign(key, fileId, variant, exp))
            if (MessageDigest.isEqual(expected, provided)) valid = true
        }
        return valid
    }

    private fun sign(key: ByteArray, fileId: Uuid, variant: String, exp: Long): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(key, ALGORITHM))
        val message = "$fileId|$variant|$exp".toByteArray(Charsets.UTF_8)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(message))
    }

    companion object {
        const val MIN_KEY_BYTES = 32
        val MAX_LIFETIME = 1.hours
        val CLOCK_SKEW = 60.seconds
        private const val ALGORITHM = "HmacSHA256"

        /**
         * Reads the key list: keys separated by commas or line breaks, each base64 or base64url of at least
         * [MIN_KEY_BYTES] random bytes. The text of a key is never part of an error message.
         */
        fun parseKeys(text: String, name: String): List<ByteArray> {
            val parts = text.split(',', '\n', '\r', ' ', '\t').map { it.trim() }.filter { it.isNotEmpty() }
            require(parts.isNotEmpty()) { "$name must hold at least one key (base64 of at least $MIN_KEY_BYTES random bytes)" }
            return parts.mapIndexed { index, part ->
                val decoded = try {
                    Base64.getDecoder().decode(part.replace('-', '+').replace('_', '/'))
                } catch (_: IllegalArgumentException) {
                    throw IllegalArgumentException("$name: key ${index + 1} is not base64")
                }
                require(
                    decoded.size >= MIN_KEY_BYTES,
                ) { "$name: key ${index + 1} has ${decoded.size} bytes, needs at least $MIN_KEY_BYTES" }
                decoded
            }
        }
    }
}
