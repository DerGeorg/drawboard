package at.dergeorg.drawboard.users.domain.users.provides

import at.dergeorg.drawboard.users.domain.users.model.ColorTheme
import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import kotlin.uuid.Uuid

/** What the users module offers other modules. */
interface UserProfilesUseCase {

    /**
     * A login: creates the profile on the first call of ([SyncFromLoginCommand.issuer], [SyncFromLoginCommand.subject])
     * (UUIDv7 assigned here, audited as `users.profile.created`), otherwise refreshes the claims and the last login
     * time. Only the creation is audited - not every login. Returns the stored profile.
     */
    suspend fun syncFromLogin(command: SyncFromLoginCommand): UserProfile

    /**
     * Stores the colour theme the user chose (not audited: a display setting) and returns the stored profile. The last
     * write wins; a login refreshing the claims at the same time never resets it. [id] must belong to an existing
     * profile. Throws `CONFLICT` if concurrent changes of the profile keep winning.
     */
    suspend fun changeTheme(id: Uuid, theme: ColorTheme): UserProfile

    /** The profile of a known login, or null if this identity never signed in. Writes nothing. */
    suspend fun findByLogin(issuer: String, subject: String): UserProfile?

    /** The profile with this application-wide user id, or null. */
    suspend fun findById(id: Uuid): UserProfile?

    /** The profiles with these ids; unknown ids are left out. */
    suspend fun findAllById(ids: Collection<Uuid>): List<UserProfile>

    /**
     * Users whose username or display name starts with [prefix] (case-insensitive, taken literally), at most [limit].
     * Only users who signed in at least once exist.
     */
    suspend fun search(prefix: String, limit: Int): List<UserProfile>

    /** Whether a registered user has [name] as username or display name (case-insensitive). */
    suspend fun nameTaken(name: String): Boolean
}

/** The claims of the current access token, already mapped by the deployment's claim configuration. */
data class SyncFromLoginCommand(
    val issuer: String,
    val subject: String,
    val username: String,
    val displayName: String?,
    val email: String?,
    val groups: List<String>,
)
