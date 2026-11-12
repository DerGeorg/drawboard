package at.dergeorg.drawboard.library.domain.sharing.requires

/** Hashes and checks link passwords (S1.11: Argon2). Implemented in requires/impl; verifying is slow on purpose. */
internal interface PasswordHasher {

    suspend fun hash(password: String): String

    suspend fun matches(password: String, hash: String): Boolean
}
