package at.dergeorg.drawboard.core.infra.security

import org.bouncycastle.jce.ECNamedCurveTable
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * One guest signing key: an EC P-256 private key and its public key. [kid] is the fingerprint of the public key
 * (sha256 of its X.509 encoding, base64url) - the same key always gets the same `kid`, so verifiers find it after a restart.
 */
internal class GuestKey(val privateKey: ECPrivateKey, val publicKey: ECPublicKey) {
    val kid: String = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(publicKey.encoded),
    )
}

/** The configured keys, in order: the first signs, all verify (S1.5). */
internal class GuestKeys(val keys: List<GuestKey>) {

    val signing: GuestKey get() = keys.first()

    fun byKid(kid: String?): GuestKey? = keys.firstOrNull { it.kid == kid }

    companion object {
        private val BLOCK = Regex("-----BEGIN PRIVATE KEY-----([^-]+)-----END PRIVATE KEY-----")

        /** Reads PKCS#8 PEM blocks; anything else (a public key, an RSA key, garbage) stops the start with a clear message. */
        fun parse(pem: String): GuestKeys {
            val blocks = BLOCK.findAll(pem).map { it.groupValues[1].filterNot(Char::isWhitespace) }.toList()
            require(blocks.isNotEmpty()) {
                "DRAWBOARD_GUEST_SIGNING_KEYS must hold at least one EC P-256 private key in PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)"
            }
            return GuestKeys(blocks.map(::key))
        }

        private fun key(base64: String): GuestKey {
            val factory = KeyFactory.getInstance("EC")
            val private = try {
                factory.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(base64))) as ECPrivateKey
            } catch (e: java.security.GeneralSecurityException) {
                throw IllegalArgumentException("DRAWBOARD_GUEST_SIGNING_KEYS: a key is not an EC private key in PKCS#8", e)
            }
            val curve = ECNamedCurveTable.getParameterSpec("secp256r1")
            require(private.params.curve.field.fieldSize == P256_BITS) {
                "DRAWBOARD_GUEST_SIGNING_KEYS: only P-256 keys (ES256) are accepted"
            }
            // Q = d * G: the PKCS#8 file may not carry the public key
            val point = curve.g.multiply(private.s).normalize()
            val w = java.security.spec.ECPoint(point.affineXCoord.toBigInteger(), point.affineYCoord.toBigInteger())
            val public = factory.generatePublic(ECPublicKeySpec(w, private.params)) as ECPublicKey
            return GuestKey(private, public)
        }

        private const val P256_BITS = 256
    }
}
