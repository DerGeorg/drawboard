package at.dergeorg.drawboard.api.common

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.shared.context.CurrentUserProvider
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.provides.SyncFromLoginCommand
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Component
import kotlin.time.Instant

/**
 * Who is calling, as a profile of the `users` module: the bridge between the token (shared [CurrentUserProvider]
 * port) and the application's own user id that other modules (library, ...) are given. Lives in api because modules
 * never know each other - the ApiServices are the only place that talks to several of them.
 */
@Component
internal class SignedInUsers(
    private val currentUsers: CurrentUserProvider,
    private val profiles: UserProfilesUseCase,
) {

    /**
     * The profile of the caller; created on the first call if this identity never signed in (a client may call a
     * board route before `GET /users/me`). Does NOT count as a login: it does not touch the stored claims.
     * Throws `UNAUTHORIZED` without a token (the route table already ensures one - this is the safety net).
     */
    @WithSpan
    suspend fun profile(): UserProfile {
        val user = currentUsers.currentUserOrNull() ?: throw DomainException(ErrorCode.UNAUTHORIZED)
        return profiles.findByLogin(user.issuer, user.subject) ?: login()
    }

    /**
     * The caller as the library knows it: the user's own id plus the groups of the CURRENT token (S6.5). Creates the
     * profile on the first call like [profile].
     */
    @WithSpan
    suspend fun caller(): Caller.User {
        val user = currentUsers.currentUserOrNull() ?: throw DomainException(ErrorCode.UNAUTHORIZED)
        val profile = profiles.findByLogin(user.issuer, user.subject) ?: login()
        return Caller.User(profile.id, user.groups)
    }

    /** Like [caller], but null for an anonymous request (the link exchange is open to visitors without a token). */
    @WithSpan
    suspend fun callerOrNull(): Caller.User? {
        val user = currentUsers.currentUserOrNull() ?: return null
        val profile = profiles.findByLogin(user.issuer, user.subject) ?: login()
        return Caller.User(profile.id, user.groups)
    }

    /**
     * Whether the caller is an instance admin - decided by the groups of the CURRENT token on every request, never by
     * anything stored. Admin grants no access to boards.
     */
    @WithSpan
    suspend fun isAdmin(): Boolean = currentUsers.currentUserOrNull()?.admin ?: false

    /** The `exp` of the access token of this request; the collaboration ticket is bound to it. */
    @WithSpan
    suspend fun tokenExpiresAt(): Instant? = currentUsers.currentUserOrNull()?.tokenExpiresAt

    /** A login: creates the profile or refreshes its claims and last login time. */
    @WithSpan
    suspend fun login(): UserProfile {
        val user = currentUsers.currentUserOrNull() ?: throw DomainException(ErrorCode.UNAUTHORIZED)
        return profiles.syncFromLogin(
            SyncFromLoginCommand(
                issuer = user.issuer,
                subject = user.subject,
                username = user.username,
                displayName = user.displayName,
                email = user.email,
                groups = user.groups.sorted(),
            ),
        )
    }
}
