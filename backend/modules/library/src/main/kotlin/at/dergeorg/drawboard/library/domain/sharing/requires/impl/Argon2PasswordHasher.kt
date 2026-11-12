package at.dergeorg.drawboard.library.domain.sharing.requires.impl

import at.dergeorg.drawboard.library.domain.sharing.requires.PasswordHasher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder
import org.springframework.stereotype.Component

/**
 * Link passwords with Argon2 (S1.11): [Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8], the defaults of Spring
 * Security 7. Hashing and checking take tens of milliseconds and memory on purpose, so they run off the event loop.
 */
@Component
internal class Argon2PasswordHasher : PasswordHasher {

    private val encoder = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()

    override suspend fun hash(password: String): String =
        withContext(Dispatchers.Default) { checkNotNull(encoder.encode(password)) { "Argon2 returned no hash" } }

    override suspend fun matches(password: String, hash: String): Boolean =
        withContext(Dispatchers.Default) { runCatching { encoder.matches(password, hash) }.getOrDefault(false) }
}
