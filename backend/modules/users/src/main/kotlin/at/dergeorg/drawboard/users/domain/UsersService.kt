package at.dergeorg.drawboard.users.domain

import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.users.common.UsersModule
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.users.domain.users.model.ColorTheme
import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.provides.SyncFromLoginCommand
import at.dergeorg.drawboard.users.domain.users.provides.UserProfilesUseCase
import at.dergeorg.drawboard.users.domain.users.requires.UserProfileRepository
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import kotlin.time.Clock
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Implements every use case of the users module. The creation of a profile and its audit event share one
 * transaction - both or neither. Later logins are not audited: they would only be noise.
 */
@Service
internal class UsersService(
    private val profiles: UserProfileRepository,
    private val audit: AuditTrail,
    private val clock: Clock,
) : UserProfilesUseCase {

    private val events = DomainEvents(UsersModule.NAME)

    @WithSpan
    @Transactional
    override suspend fun syncFromLogin(command: SyncFromLoginCommand): UserProfile {
        val now = clock.now()
        val existing = profiles.findByLogin(command.issuer, command.subject) ?: return create(command, now)

        val refreshed = existing.copy(
            username = command.username,
            displayName = command.displayName,
            email = command.email,
            groups = command.groups,
            lastLoginAt = now,
        )
        // A concurrent login of the same user was faster: its profile is just as current as ours would be.
        return profiles.update(refreshed) ?: currentProfile(command)
    }

    /**
     * Not audited (a display setting). No surrounding transaction on purpose: every attempt reads and writes on its own,
     * so a profile changed in between (typically a login refreshing the claims) is read again and the theme is set on
     * top of it - the last write wins.
     */
    @WithSpan
    override suspend fun changeTheme(@SpanAttribute("user.id") id: Uuid, theme: ColorTheme): UserProfile {
        repeat(THEME_ATTEMPTS) {
            val stored = checkNotNull(profiles.findById(id)) { "user profile $id does not exist" }
            if (stored.theme == theme) return stored
            val changed = profiles.update(stored.copy(theme = theme))
            if (changed != null) return changed
        }
        throw DomainException(ErrorCode.CONFLICT)
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun findByLogin(issuer: String, subject: String): UserProfile? = profiles.findByLogin(issuer, subject)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun findById(@SpanAttribute("user.id") id: Uuid): UserProfile? = profiles.findById(id)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun findAllById(ids: Collection<Uuid>): List<UserProfile> = profiles.findAllById(ids)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun search(prefix: String, limit: Int): List<UserProfile> = profiles.searchByPrefix(prefix, limit)

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun nameTaken(name: String): Boolean = profiles.existsByName(name)

    private suspend fun create(command: SyncFromLoginCommand, now: Instant): UserProfile {
        val profile = UserProfile(
            id = Uuid.generateV7(),
            issuer = command.issuer,
            subject = command.subject,
            username = command.username,
            displayName = command.displayName,
            email = command.email,
            groups = command.groups,
            firstLoginAt = now,
            lastLoginAt = now,
        )
        if (!profiles.insertIfAbsent(profile)) {
            // A concurrent first request of the same user was faster: its profile is the one that exists.
            return currentProfile(command)
        }
        audit.record(events.created(PROFILE, profile.id, after = profile))
        return profile
    }

    private suspend fun currentProfile(command: SyncFromLoginCommand): UserProfile =
        checkNotNull(profiles.findByLogin(command.issuer, command.subject)) {
            "user profile of ${command.issuer} / ${command.subject} exists but cannot be read"
        }

    private companion object {
        const val PROFILE = "profile"
        const val THEME_ATTEMPTS = 3
    }
}
