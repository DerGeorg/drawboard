package at.dergeorg.drawboard.library.domain.sharing

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** Link tokens (S1.1): 256 bit from [SecureRandom], base64url; the database stores only the sha256 of the token. */
internal object ShareTokens {

    private val random = SecureRandom()

    /** A fresh token, 43 characters of base64url without padding. */
    fun generate(): String =
        ByteArray(TOKEN_BYTES).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    /** sha256 of the token's UTF-8 bytes as lowercase hex - the lookup key. */
    fun hash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** A token longer than any we create cannot be ours; it is not even hashed. */
    fun plausible(token: String): Boolean = token.length in 1..MAX_LENGTH

    private const val TOKEN_BYTES = 32
    private const val MAX_LENGTH = 128
}
