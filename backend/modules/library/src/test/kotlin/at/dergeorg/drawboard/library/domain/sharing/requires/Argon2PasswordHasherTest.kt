package at.dergeorg.drawboard.library.domain.sharing.requires

import at.dergeorg.drawboard.library.domain.sharing.requires.impl.Argon2PasswordHasher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class Argon2PasswordHasherTest {

    private val hasher = Argon2PasswordHasher()

    @Test
    fun `when hashing then the hash is Argon2id, salted and never contains the password`() = runTest {
        val first = hasher.hash("correct horse battery")
        val second = hasher.hash("correct horse battery")

        assertTrue(first.startsWith("\$argon2id\$"), "Argon2id, was ${first.take(12)}")
        assertFalse("correct horse" in first, "the hash does not contain the password")
        assertNotEquals(first, second, "a random salt per hash")
    }

    @Test
    fun `when checking then the right password matches and a wrong one, an empty one and garbage do not`() = runTest {
        val hash = hasher.hash("correct horse battery")

        assertTrue(hasher.matches("correct horse battery", hash), "right password")
        assertFalse(hasher.matches("correct horse batter", hash), "wrong password")
        assertFalse(hasher.matches("", hash), "empty password")
        assertFalse(hasher.matches("correct horse battery", "not a hash"), "a stored value that is no hash never matches")
    }
}
