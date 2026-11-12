package at.dergeorg.drawboard.plugins.domain.plugins

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.uuid.Uuid

/**
 * The pseudonymous id a plugin sees for a user (S3.8): `base64url(HMAC-SHA256(key, principalId + "|" + pluginId))`
 * without padding (43 characters). Stable per user and plugin, different for every plugin, not reversible without the
 * key. The key is a secret of its own - it is NOT the key that signs file URLs; rotating it gives every user a new id.
 */
internal class UserPseudonyms(private val key: ByteArray) {
    init {
        require(key.size >= MIN_KEY_BYTES) { "DRAWBOARD_PLUGIN_PSEUDONYM_KEY needs at least $MIN_KEY_BYTES bytes" }
    }

    fun of(principalId: Uuid, pluginId: String): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(key, ALGORITHM))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal("$principalId|$pluginId".toByteArray(Charsets.UTF_8)))
    }

    companion object {
        const val MIN_KEY_BYTES = 32
        private const val ALGORITHM = "HmacSHA256"

        /** One key, base64 or base64url; fewer than 32 bytes stops the start (the key text is never part of the message). */
        fun parseKey(text: String, name: String): ByteArray {
            val trimmed = text.trim()
            require(trimmed.isNotEmpty()) { "$name must be set: a secret of at least $MIN_KEY_BYTES random bytes (base64)" }
            val decoded = try {
                Base64.getDecoder().decode(trimmed.replace('-', '+').replace('_', '/'))
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException("$name is not base64")
            }
            require(decoded.size >= MIN_KEY_BYTES) { "$name has ${decoded.size} bytes, needs at least $MIN_KEY_BYTES" }
            return decoded
        }
    }
}
