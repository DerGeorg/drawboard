package at.dergeorg.drawboard.users.domain

import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.requires.UserProfileRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fake of the internal [UserProfileRepository] port; [update] checks the version like the real adapter. */
internal class InMemoryUserProfileRepository(vararg initial: UserProfile) : UserProfileRepository {
    private val profiles = linkedMapOf<Uuid, UserProfile>().apply { initial.forEach { put(it.id, it) } }

    /** Set to make the next [update] fail like a concurrent change would. */
    var failNextUpdate = false

    /** Set to make every [update] fail. */
    var failAllUpdates = false

    val all: List<UserProfile> get() = profiles.values.toList()

    override suspend fun findById(id: Uuid): UserProfile? = profiles[id]

    override suspend fun findByLogin(issuer: String, subject: String): UserProfile? =
        profiles.values.firstOrNull { it.issuer == issuer && it.subject == subject }

    override suspend fun findAllById(ids: Collection<Uuid>) = profiles.values.filter { it.id in ids }

    override suspend fun searchByPrefix(prefix: String, limit: Int) = profiles.values
        .filter { it.username.startsWith(prefix, true) || it.displayName?.startsWith(prefix, true) == true }
        .sortedBy { it.username }.take(limit)

    override suspend fun existsByName(name: String) =
        profiles.values.any { it.username.equals(name, true) || it.displayName.equals(name, true) }

    override suspend fun countLoggedInSince(since: Instant): Long = profiles.values.count { it.lastLoginAt > since }.toLong()

    override suspend fun insertIfAbsent(profile: UserProfile): Boolean {
        if (findByLogin(profile.issuer, profile.subject) != null) return false
        return profiles.putIfAbsent(profile.id, profile) == null
    }

    override suspend fun update(profile: UserProfile): UserProfile? {
        val stored = checkNotNull(profiles[profile.id]) { "no profile ${profile.id}" }
        if (failAllUpdates || failNextUpdate || stored.version != profile.version) {
            failNextUpdate = false
            return null
        }
        return profile.copy(version = profile.version + 1).also { profiles[it.id] = it }
    }
}
