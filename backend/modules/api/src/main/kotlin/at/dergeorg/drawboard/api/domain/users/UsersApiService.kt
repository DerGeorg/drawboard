package at.dergeorg.drawboard.api.domain.users

import at.dergeorg.drawboard.api.common.SignedInUsers
import at.dergeorg.drawboard.api.domain.users.users.provides.UsersApiUseCase
import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.contract.model.ColorTheme
import at.dergeorg.drawboard.contract.model.CurrentUser
import at.dergeorg.drawboard.contract.model.UserPreferences
import at.dergeorg.drawboard.contract.model.UserSummary
import at.dergeorg.drawboard.contract.model.UserSummaryList
import at.dergeorg.drawboard.gifs.domain.search.provides.GifSearchUseCase
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.domain.users.model.ColorTheme as StoredTheme
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes

/** Implements the API use cases that belong to the users module: the token's claims in, the stored profile out. */
@Service
internal class UsersApiService(
    private val signedIn: SignedInUsers,
    private val profiles: UserProfilesUseCase,
    private val properties: DrawboardProperties,
    private val gifs: GifSearchUseCase,
    clock: Clock,
) : UsersApiUseCase {

    private val searches = WindowRateLimiter(clock, RateRule(SEARCHES_PER_MINUTE, 1.minutes))

    @WithSpan
    override suspend fun getCurrentUser(): CurrentUser {
        val profile = signedIn.login()
        return CurrentUser(
            id = profile.id,
            username = profile.username,
            admin = signedIn.isAdmin(),
            guestLinksEnabled = properties.guestsEnabled,
            gifsEnabled = gifs.isEnabled(),
            displayName = profile.displayName,
            email = profile.email,
            theme = profile.theme.toContract(),
        )
    }

    /**
     * Replaces the settings of the caller; the profile is created first if this is their first call (like for a board
     * route). The answer is what was stored.
     */
    @WithSpan
    override suspend fun updateUserPreferences(preferences: UserPreferences): UserPreferences {
        val profile = signedIn.profile()
        val stored = profiles.changeTheme(profile.id, preferences.theme.toStored())
        return UserPreferences(theme = stored.theme.toContract())
    }

    /**
     * Prefix search for picking a member (S6.9): signed-in users only (the route table keeps guests out), 30 per user
     * and minute (S7.3), at most 20 hits, username and display name only - never an email address. Switched off by
     * `DRAWBOARD_USER_SEARCH=off`: always empty.
     */
    @WithSpan
    override suspend fun searchUsers(q: String): UserSummaryList {
        val caller = signedIn.caller()
        if (!properties.userSearchEnabled) return UserSummaryList(items = emptyList())
        searches.take(caller.id.toString())
        val term = q.trim()
        if (term.length < MIN_QUERY) {
            throw ValidationFailedException(listOf(InvalidField("q", "Size", "size must be at least $MIN_QUERY")))
        }
        val hits = profiles.search(term, MAX_HITS).map { UserSummary(id = it.id, username = it.username, displayName = it.displayName) }
        return UserSummaryList(items = hits)
    }

    private fun StoredTheme.toContract() = ColorTheme.valueOf(name)

    private fun ColorTheme.toStored() = StoredTheme.valueOf(name)

    private companion object {
        const val SEARCHES_PER_MINUTE = 30
        const val MIN_QUERY = 2
        const val MAX_HITS = 20
    }
}
