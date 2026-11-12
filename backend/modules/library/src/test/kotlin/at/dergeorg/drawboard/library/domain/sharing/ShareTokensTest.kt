package at.dergeorg.drawboard.library.domain.sharing

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class ShareTokensTest {

    @Test
    fun `when generating then the token is 256 bit as 43 characters of base64url and never repeats`() {
        val tokens = List(50) { ShareTokens.generate() }

        assertTrue(tokens.all { it.length == 43 && it.matches(Regex("[A-Za-z0-9_-]+")) }, "43 base64url characters without padding")
        assertEquals(tokens.size, tokens.toSet().size, "no repetition")
    }

    @Test
    fun `when hashing then it is the known sha256 as lowercase hex and differs per token`() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ShareTokens.hash("abc"), "sha256 of abc")
        assertNotEquals(ShareTokens.hash("a"), ShareTokens.hash("b"), "different tokens, different hashes")
    }

    @Test
    fun `when judging plausibility then empty and over-long tokens are rejected without hashing`() {
        assertFalse(ShareTokens.plausible(""), "empty")
        assertFalse(ShareTokens.plausible("x".repeat(129)), "longer than any token we create")
        assertTrue(ShareTokens.plausible(ShareTokens.generate()), "a real token")
    }
}
