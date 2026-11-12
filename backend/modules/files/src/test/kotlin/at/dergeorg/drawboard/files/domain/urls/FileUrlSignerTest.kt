package at.dergeorg.drawboard.files.domain.urls

import at.dergeorg.drawboard.files.domain.files.model.FileVariant
import at.dergeorg.drawboard.shared.testing.MutableClock
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.uuid.Uuid

class FileUrlSignerTest {

    private val clock = MutableClock()
    private val key1 = ByteArray(32) { 1 }
    private val key2 = ByteArray(32) { 2 }
    private val signer = FileUrlSigner(listOf(key1), clock)
    private val fileId = Uuid.generateV7()

    /** The three parts of an issued URL. */
    private fun parts(url: String): Triple<String, Long, String> {
        val query = url.substringAfter('?').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
        return Triple(query.getValue("v"), query.getValue("exp").toLong(), query.getValue("sig"))
    }

    @Nested
    inner class Issuing {

        @Test
        fun `when issuing a url then it has the format of the contract and a signature of 43 characters`() {
            val url = signer.url(fileId, FileVariant.THUMBNAIL, signer.expiry())

            assertTrue(url.startsWith("/files/$fileId?v=thumbnail&exp="), "path and variant, was $url")
            assertEquals(43, parts(url).third.length, "base64url of 32 bytes without padding")
            assertEquals(clock.now().epochSeconds + 3600, parts(url).second, "one hour")
        }

        @Test
        fun `when issuing a url then the signature is the HMAC of fileId, variant and expiry`() {
            val (variant, exp, sig) = parts(signer.url(fileId, FileVariant.ORIGINAL, signer.expiry()))
            val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply { init(javax.crypto.spec.SecretKeySpec(key1, "HmacSHA256")) }
            val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal("$fileId|$variant|$exp".toByteArray()))

            assertEquals(expected, sig, "fileId|v|exp in lowercase canonical form")
        }
    }

    @Nested
    inner class Verifying {

        private fun valid(url: String): Boolean {
            val (variant, exp, sig) = parts(url)
            return signer.verify(fileId, variant, exp, sig)
        }

        @Test
        fun `when verifying a fresh url then it is valid`() {
            assertTrue(valid(signer.url(fileId, FileVariant.ORIGINAL, signer.expiry())), "fresh")
        }

        @Test
        fun `when the expiry has passed then it is invalid`() {
            val url = signer.url(fileId, FileVariant.ORIGINAL, signer.expiry())
            clock.advanceBy(1.hours + 1.seconds)

            assertFalse(valid(url), "past")
        }

        @Test
        fun `when the expiry lies further ahead than the lifetime plus a minute then it is invalid - even with a correct signature`() {
            val tooFar = clock.now() + 1.hours + 2.minutes
            val farUrl = signer.url(fileId, FileVariant.ORIGINAL, tooFar)
            val withinSkew = signer.url(fileId, FileVariant.ORIGINAL, clock.now() + 1.hours + 30.seconds)

            assertFalse(valid(farUrl), "a leaked key must not mint URLs that live for a year")
            assertTrue(valid(withinSkew), "a minute of clock skew is tolerated")
        }

        @Test
        fun `when the variant, the expiry, the file or the signature is changed then it is invalid`() {
            val (variant, exp, sig) = parts(signer.url(fileId, FileVariant.ORIGINAL, signer.expiry()))

            assertFalse(signer.verify(fileId, "pdf", exp, sig), "another variant")
            assertFalse(signer.verify(fileId, variant, exp + 1, sig), "another expiry")
            assertFalse(signer.verify(Uuid.generateV7(), variant, exp, sig), "another file")
            assertFalse(signer.verify(fileId, variant, exp, sig.reversed()), "another signature")
            assertFalse(signer.verify(fileId, variant, exp, "!!!"), "not base64")
            assertFalse(signer.verify(fileId, variant, exp, ""), "empty")
        }

        @Test
        fun `when the url was signed with another key then it is invalid`() {
            val foreign = FileUrlSigner(listOf(key2), clock).url(fileId, FileVariant.ORIGINAL, signer.expiry())

            assertFalse(valid(foreign), "wrong key")
        }

        @Test
        fun `when the key was rotated then urls of the old key still verify but new ones are signed with the new key`() {
            val old = signer.url(fileId, FileVariant.ORIGINAL, signer.expiry())
            val rotated = FileUrlSigner(listOf(key2, key1), clock)

            val (variant, exp, sig) = parts(old)
            assertTrue(rotated.verify(fileId, variant, exp, sig), "all keys verify")
            val fresh = parts(rotated.url(fileId, FileVariant.ORIGINAL, rotated.expiry()))
            assertTrue(FileUrlSigner(listOf(key2), clock).verify(fileId, fresh.first, fresh.second, fresh.third), "the first key signs")
            assertFalse(signer.verify(fileId, fresh.first, fresh.second, fresh.third), "the retired key cannot verify new urls")
        }

        @Test
        fun `when the old key is dropped then its urls are invalid`() {
            val old = signer.url(fileId, FileVariant.ORIGINAL, signer.expiry())
            val dropped = FileUrlSigner(listOf(key2), clock)

            val (variant, exp, sig) = parts(old)
            assertFalse(dropped.verify(fileId, variant, exp, sig), "retired key")
        }
    }

    @Nested
    inner class Keys {

        private fun encode(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

        @Test
        fun `when parsing keys then a comma or line separated list of base64 or base64url keys is read`() {
            val keys = FileUrlSigner.parseKeys(
                "${encode(key1)}, ${encode(key2)}\n${Base64.getUrlEncoder().encodeToString(ByteArray(40) { 9 })}",
                "K",
            )

            assertEquals(3, keys.size, "three keys")
            assertEquals(40, keys[2].size, "bytes of the third")
        }

        @Test
        fun `when a key has fewer than 32 bytes then the start fails without printing the key`() {
            val failure = assertFailsWith<IllegalArgumentException>(
                "short key",
            ) { FileUrlSigner.parseKeys(encode(ByteArray(16) { 7 }), "K") }

            assertFalse(encode(ByteArray(16) { 7 }) in failure.message.orEmpty(), "the key text is never part of a message")
        }

        @Test
        fun `when there is no key then the start fails`() {
            assertFailsWith<IllegalArgumentException>("empty") { FileUrlSigner.parseKeys("  ", "K") }
            assertFailsWith<IllegalArgumentException>("no signer without keys") { FileUrlSigner(emptyList(), clock) }
        }

        @Test
        fun `when the lifetime is longer than an hour then it is refused`() {
            assertFailsWith<IllegalArgumentException>("S4.4: at most one hour") { FileUrlSigner(listOf(key1), clock, lifetime = 2.hours) }
        }
    }
}
