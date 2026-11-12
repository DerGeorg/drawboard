package at.dergeorg.drawboard.users.domain.users.requires

import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Persistence port of user profiles. Implemented in requires/impl (Spring Data R2DBC). */
internal interface UserProfileRepository {

    suspend fun findById(id: Uuid): UserProfile?

    suspend fun findByLogin(issuer: String, subject: String): UserProfile?

    suspend fun findAllById(ids: Collection<Uuid>): List<UserProfile>

    /**
     * Profiles whose username or display name starts with [prefix] (case-insensitive), by username, at most [limit].
     * [prefix] is taken literally: `%`, `_` and `\` are no wildcards.
     */
    suspend fun searchByPrefix(prefix: String, limit: Int): List<UserProfile>

    /** Whether any profile has [name] (case-insensitive) as username or display name. */
    suspend fun existsByName(name: String): Boolean

    /**
     * Inserts the profile unless one with the same id or the same (issuer, subject) exists - also one inserted by a
     * concurrent transaction (the first requests of a new user often arrive in parallel). false if nothing was
     * inserted.
     */
    suspend fun insertIfAbsent(profile: UserProfile): Boolean

    /**
     * Stores the changes of [profile] if the stored version is still `profile.version` and returns it with the next
     * version - or null if a concurrent request changed it in between (optimistic lock).
     */
    suspend fun update(profile: UserProfile): UserProfile?

    /** How many profiles signed in after [since] - for the gauge `drawboard.users.active`. */
    suspend fun countLoggedInSince(since: Instant): Long
}
