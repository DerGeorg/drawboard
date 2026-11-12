package at.dergeorg.drawboard.library.domain.sharing.provides.impl

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.common.LibraryProperties
import at.dergeorg.drawboard.library.domain.access.AccessResolver
import at.dergeorg.drawboard.library.domain.access.LibraryErrors
import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.access.model.Grant
import at.dergeorg.drawboard.library.domain.access.model.PrincipalKind
import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import at.dergeorg.drawboard.library.domain.boards.BoardAccess
import at.dergeorg.drawboard.library.domain.boards.model.BoardRole
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.library.domain.sharing.ShareTokens
import at.dergeorg.drawboard.library.domain.sharing.model.CreatedLink
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeFailure
import at.dergeorg.drawboard.library.domain.sharing.model.ExchangeOutcome
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareCreated
import at.dergeorg.drawboard.library.domain.sharing.model.ShareExchangeFailed
import at.dergeorg.drawboard.library.domain.sharing.model.ShareExchanged
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import at.dergeorg.drawboard.library.domain.sharing.model.ShareRevoked
import at.dergeorg.drawboard.library.domain.sharing.provides.CreateLinkCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.ExchangeCommand
import at.dergeorg.drawboard.library.domain.sharing.provides.LinksUseCase
import at.dergeorg.drawboard.library.domain.sharing.provides.RevokedLink
import at.dergeorg.drawboard.library.domain.sharing.requires.PasswordHasher
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareMetrics
import at.dergeorg.drawboard.shared.auditing.AuditAction
import at.dergeorg.drawboard.shared.auditing.AuditTrail
import at.dergeorg.drawboard.shared.auditing.DomainEvents
import at.dergeorg.drawboard.shared.error.DomainException
import at.dergeorg.drawboard.shared.error.ErrorCode
import at.dergeorg.drawboard.shared.error.InvalidField
import at.dergeorg.drawboard.shared.error.ValidationFailedException
import at.dergeorg.drawboard.shared.security.IpBuckets
import at.dergeorg.drawboard.shared.security.RateRule
import at.dergeorg.drawboard.shared.security.WindowRateLimiter
import io.opentelemetry.instrumentation.annotations.SpanAttribute
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Clock
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Implements the share link use cases. See [LinksUseCase] for the rules; the numbers are those of S1.11 and S1.12. */
@Service
@Suppress("TooManyFunctions")
internal class LinksService(
    private val links: ShareLinkRepository,
    private val boards: BoardRepository,
    private val folders: FolderRepository,
    private val grants: GrantRepository,
    private val access: AccessResolver,
    private val passwords: PasswordHasher,
    private val metrics: ShareMetrics,
    properties: LibraryProperties,
    private val audit: AuditTrail,
    private val clock: Clock,
) : LinksUseCase {

    private val events = DomainEvents(LibraryModule.NAME)

    /** Every exchange or refresh attempt per client address, whatever its outcome (S7.3). */
    private val attempts = WindowRateLimiter(clock, RateRule(properties.exchangesPerMinute, 1.minutes))

    /** Every password verification per link and client address, correct ones included (S1.11, S7.3). */
    private val verifications = WindowRateLimiter(clock, RateRule(properties.passwordChecksPerMinute, 1.minutes))

    /** key -> until when a rate-limit audit event was written: one event per block window and key, not one per attempt. */
    private val auditedUntil = ConcurrentHashMap<String, Instant>()

    private val invalidTokens = WindowRateLimiter(clock, RateRule(INVALID_TOKENS_PER_MINUTE, 1.minutes))
    private val passwordsPerShareAndIp = WindowRateLimiter(clock, RateRule(PASSWORD_FAILURES_PER_MINUTE, 1.minutes))
    private val passwordsPerShare = WindowRateLimiter(clock, RateRule(PASSWORD_FAILURES_PER_HOUR, 1.hours))

    /** shareId -> (answer, when it was read). A cache of at most [GUEST_CACHE_SECONDS]: revocation takes at most that long. */
    private val guestCache = ConcurrentHashMap<Uuid, Pair<Caller.Guest?, Instant>>()

    @WithSpan
    @Transactional
    override suspend fun createLink(command: CreateLinkCommand): CreatedLink {
        val owned = requireOwner(command.caller, command.kind, command.resourceId)
        if (command.role == BoardRole.OWNER) throw invalid("role", "a link never grants OWNER")
        val now = clock.now()
        if (command.expiresAt != null && command.expiresAt <= now) throw invalid("expiresAt", "must lie in the future")
        val password = command.password
        if (password != null && password.length < MIN_PASSWORD) {
            throw invalid("password", "must have at least $MIN_PASSWORD characters")
        }
        val token = ShareTokens.generate()
        val link = links.insert(
            ShareLink(
                id = Uuid.generateV7(),
                resourceKind = command.kind,
                resourceId = command.resourceId,
                role = command.role,
                audience = command.audience,
                tokenHash = ShareTokens.hash(token),
                passwordHash = password?.let { passwords.hash(it) },
                expiresAt = command.expiresAt,
                revokedAt = null,
                useCount = 0,
                createdAt = now,
                createdBy = owned,
            ),
        )
        val details = ShareCreated(
            resourceKind = link.resourceKind.name,
            resourceId = link.resourceId.toString(),
            role = link.role.name,
            audience = link.audience.name,
            expiresAt = link.expiresAt?.toString(),
            passwordSet = link.passwordProtected,
        )
        audit.record(events.of(SHARE, link.id, AuditAction.CREATED, "created", details))
        return CreatedLink(link, token)
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun listLinks(
        caller: Caller,
        kind: ResourceKind,
        @SpanAttribute("resource.id") resourceId: Uuid,
    ): List<ShareLink> {
        requireOwner(caller, kind, resourceId)
        return links.findByResource(kind, resourceId)
    }

    @WithSpan
    @Transactional
    override suspend fun revokeLink(caller: Caller, @SpanAttribute("share.id") linkId: Uuid): RevokedLink {
        val link = links.findById(linkId) ?: throw shareNotFound()
        // Whoever may not manage the resource must not learn that the link exists.
        runCatching { requireOwner(caller, link.resourceKind, link.resourceId) }.getOrElse { throw shareNotFound() }
        if (links.revoke(linkId, clock.now())) {
            grants.removeByLink(linkId)
            guestCache.remove(linkId)
            val details = ShareRevoked(link.resourceKind.name, link.resourceId.toString())
            audit.record(events.of(SHARE, linkId, AuditAction.UPDATED, "revoked", details))
        }
        return RevokedLink(link.resourceKind, link.resourceId)
    }

    @WithSpan
    @Transactional
    override suspend fun exchange(command: ExchangeCommand): ExchangeOutcome {
        val outcome = decide(command)
        when (outcome) {
            is ExchangeOutcome.Failed -> metrics.exchange(outcome.reason.name.lowercase())
            is ExchangeOutcome.SignedIn -> metrics.exchange("signed_in")
            is ExchangeOutcome.Guest -> {
                metrics.exchange("guest")
                metrics.guestSession()
            }
        }
        return outcome
    }

    @WithSpan
    @Transactional(readOnly = true)
    override suspend fun guestCaller(@SpanAttribute("share.id") shareId: Uuid): Caller.Guest? {
        val now = clock.now()
        guestCache[shareId]?.takeIf { now - it.second < GUEST_CACHE_SECONDS.seconds }?.let { return it.first }
        val guest = currentGuest(shareId, now)
        guestCache[shareId] = guest to now
        if (guestCache.size > GUEST_CACHE_MAX) {
            guestCache.entries.removeIf { now - it.value.second >= GUEST_CACHE_SECONDS.seconds }
        }
        return guest
    }

    @WithSpan
    @Transactional
    @Suppress("ReturnCount")
    override suspend fun checkRefresh(@SpanAttribute("share.id") shareId: Uuid, token: String, ip: String): ExchangeOutcome {
        val address = IpBuckets.of(ip)
        attemptLimit(address, ip)?.let { return it }
        val blocked = invalidTokens.retryAfterSeconds(address)
        if (blocked > 0) return limited("invalid|$address", ip, shareId = null, wait = blocked)
        val link = if (ShareTokens.plausible(token)) links.findByTokenHash(ShareTokens.hash(token)) else null
        val now = clock.now()
        // The token must be that of the link the guest session came from, and the link must still work.
        val valid = link != null && link.id == shareId && link.audience == ShareAudience.GUESTS
        if (link == null || !valid || !usable(link, now)) {
            invalidTokens.record(address)
            return fail(ExchangeFailure.NOT_FOUND, ip, link?.id)
        }
        metrics.guestSession()
        return guestOutcome(link, passwordVerified = true)
    }

    // ------------------------------------------------------------------------------------------------ exchange

    @Suppress("ReturnCount") // a chain of checks, each ending the exchange with its own failure: early returns read best
    private suspend fun decide(command: ExchangeCommand): ExchangeOutcome {
        val ip = command.ip
        val address = IpBuckets.of(ip)
        attemptLimit(address, ip)?.let { return it }
        val blocked = invalidTokens.retryAfterSeconds(address)
        if (blocked > 0) return limited("invalid|$address", ip, shareId = null, wait = blocked)
        val link = if (ShareTokens.plausible(command.token)) links.findByTokenHash(ShareTokens.hash(command.token)) else null
        val now = clock.now()
        if (link == null || !usable(link, now)) {
            invalidTokens.record(address)
            return fail(ExchangeFailure.NOT_FOUND, ip, link?.id)
        }
        val caller = command.caller
        // Nobody to ask for a password yet: who has to sign in first learns nothing about it.
        if (caller == null && (link.audience == ShareAudience.SIGNED_IN || !command.guestsEnabled)) {
            return fail(ExchangeFailure.LOGIN_REQUIRED, ip, link.id)
        }
        passwordFailure(link, command.password, ip)?.let { return it }
        if (caller == null && command.guestName == null) return fail(ExchangeFailure.NAME_REQUIRED, ip, link.id)

        links.incrementUseCount(link.id)
        return if (caller == null) {
            val guest = guestOutcome(link, passwordVerified = link.passwordProtected)
            val details = ShareExchanged(ip, guest = true, role = link.role.name)
            audit.record(events.of(SHARE, link.id, AuditAction.EXECUTED, "exchanged", details))
            guest
        } else {
            val role = rememberFor(caller, link)
            val details = ShareExchanged(ip, guest = false, role = role.name)
            audit.record(events.of(SHARE, link.id, AuditAction.EXECUTED, "exchanged", details))
            ExchangeOutcome.SignedIn(link.resourceKind, link.resourceId, role)
        }
    }

    /** null if the password is fine (or none is needed); otherwise the failure, already counted and audited. */
    @Suppress("ReturnCount")
    private suspend fun passwordFailure(link: ShareLink, given: String?, ip: String): ExchangeOutcome.Failed? {
        val hash = link.passwordHash ?: return null
        if (given == null) return fail(ExchangeFailure.PASSWORD_REQUIRED, ip, link.id)
        val keyIp = "${link.id}|${IpBuckets.of(ip)}"
        val key = link.id.toString()
        val failureWait = maxOf(passwordsPerShareAndIp.retryAfterSeconds(keyIp), passwordsPerShare.retryAfterSeconds(key))
        val checkWait = verifications.retryAfterSeconds(keyIp)
        verifications.record(keyIp) // every verification counts, the right password too
        if (failureWait > 0 || checkWait > 0) {
            if (failureWait > 0) {
                // an attempt while blocked by the failure rules makes the next delay longer
                passwordsPerShareAndIp.record(keyIp)
                passwordsPerShare.record(key)
            }
            return limited("password|$keyIp", ip, link.id, maxOf(failureWait, checkWait))
        }
        if (passwords.matches(given, hash)) return null
        passwordsPerShareAndIp.record(keyIp)
        passwordsPerShare.record(key)
        return fail(ExchangeFailure.PASSWORD_INVALID, ip, link.id)
    }

    /** Counts this attempt of the address; the failure if it is over [LibraryProperties.exchangesPerMinute]. */
    private suspend fun attemptLimit(address: String, ip: String): ExchangeOutcome.Failed? {
        val wait = attempts.retryAfterSeconds(address)
        attempts.record(address)
        return if (wait > 0) limited("attempts|$address", ip, shareId = null, wait = wait) else null
    }

    /** Remembers the link's role for the user; returns the role they have now. The owner keeps being the owner. */
    private suspend fun rememberFor(user: Caller.User, link: ShareLink): BoardRole {
        val current = resourceRole(user, link.resourceKind, link.resourceId)
        if (current != null && current <= link.role) return current // already at least that much: nothing to remember
        val now = clock.now()
        grants.put(
            Grant(
                id = Uuid.generateV7(),
                resourceKind = link.resourceKind,
                resourceId = link.resourceId,
                principalKind = PrincipalKind.LINK_USER,
                principal = user.id.toString(),
                role = link.role,
                linkId = link.id,
                createdAt = now,
                updatedAt = now,
            ),
        )
        return link.role
    }

    private fun guestOutcome(link: ShareLink, passwordVerified: Boolean) = ExchangeOutcome.Guest(
        shareId = link.id,
        kind = link.resourceKind,
        resourceId = link.resourceId,
        role = link.role,
        shareExpiresAt = link.expiresAt,
        passwordVerified = passwordVerified,
    )

    /** A real failure (unknown token, wrong password, ...): audited every time. */
    private suspend fun fail(
        reason: ExchangeFailure,
        ip: String,
        shareId: Uuid?,
    ): ExchangeOutcome.Failed {
        auditFailure(reason, ip, shareId)
        return ExchangeOutcome.Failed(reason)
    }

    /**
     * A rate-limited attempt (S7.1): counted by the metric (in [exchange]) and audited at most ONCE per block window and
     * [key] - a blocked address must not fill the audit trail with one row per request.
     */
    private suspend fun limited(key: String, ip: String, shareId: Uuid?, wait: Long): ExchangeOutcome.Failed {
        val now = clock.now()
        if (auditedUntil[key]?.let { now < it } != true) {
            auditedUntil[key] = now + wait.seconds
            if (auditedUntil.size > AUDIT_KEYS_MAX) auditedUntil.entries.removeIf { now >= it.value }
            auditFailure(ExchangeFailure.RATE_LIMITED, ip, shareId)
        }
        return ExchangeOutcome.Failed(ExchangeFailure.RATE_LIMITED, wait)
    }

    private suspend fun auditFailure(reason: ExchangeFailure, ip: String, shareId: Uuid?) {
        audit.record(
            events.of(
                SHARE, shareId ?: NO_SHARE, AuditAction.FAILED, "exchange-failed",
                ShareExchangeFailed(reason.name, ip, shareId?.toString()),
            ),
        )
    }

    // --------------------------------------------------------------------------------------------------- helpers

    /** A link is usable while neither revoked nor expired and what it points at is not in the trash or gone. */
    private suspend fun usable(link: ShareLink, now: Instant): Boolean =
        link.usable(now) && resourceExists(link.resourceKind, link.resourceId)

    private suspend fun resourceExists(kind: ResourceKind, id: Uuid): Boolean = when (kind) {
        ResourceKind.BOARD -> boards.findById(id)?.let { it.deletedAt == null } == true
        ResourceKind.FOLDER -> folders.findById(id)?.let { it.deletedAt == null } == true
    }

    private suspend fun currentGuest(shareId: Uuid, now: Instant): Caller.Guest? {
        val link = links.findById(shareId) ?: return null
        if (!usable(link, now) || link.audience != ShareAudience.GUESTS) return null
        return Caller.Guest(link.id, link.resourceKind, link.resourceId, link.role)
    }

    private suspend fun resourceRole(user: Caller.User, kind: ResourceKind, id: Uuid): BoardRole? = when (kind) {
        ResourceKind.BOARD -> boards.findById(id)?.let { access.boardRole(it, user) }
        ResourceKind.FOLDER -> folders.findById(id)?.let { access.folderRole(it, user) }
    }

    /** The owner of the resource, else "not found" (no role) or 403 (a role below owner). Returns the caller's user id. */
    @Suppress("ThrowsCount")
    private suspend fun requireOwner(caller: Caller, kind: ResourceKind, id: Uuid): Uuid {
        val user = caller as? Caller.User ?: throw DomainException(ErrorCode.FORBIDDEN)
        val role = when (kind) {
            ResourceKind.BOARD -> boards.findById(id)?.takeIf { it.deletedAt == null }
                ?.let { access.boardRole(it, caller) } ?: throw LibraryErrors.boardNotFound(id)
            ResourceKind.FOLDER -> folders.findById(id)?.takeIf { it.deletedAt == null }
                ?.let { access.folderRole(it, caller) } ?: throw LibraryErrors.folderNotFound(id)
        }
        if (kind == ResourceKind.BOARD) BoardAccess.require(id, role, BoardAccess.CAN_DELETE)
        if (kind == ResourceKind.FOLDER && role != BoardRole.OWNER) throw DomainException(ErrorCode.FORBIDDEN)
        return user.id
    }

    private fun shareNotFound() = DomainException(ErrorCode.LIBRARY_SHARE_NOT_FOUND)

    private fun invalid(field: String, message: String) =
        ValidationFailedException(listOf(InvalidField(field = field, constraint = "Invalid", message = message)))

    private companion object {
        const val SHARE = "share"
        val NO_SHARE: Uuid = Uuid.NIL
        const val MIN_PASSWORD = 8
        const val INVALID_TOKENS_PER_MINUTE = 10
        const val PASSWORD_FAILURES_PER_MINUTE = 5
        const val PASSWORD_FAILURES_PER_HOUR = 20
        const val GUEST_CACHE_SECONDS = 30L
        const val GUEST_CACHE_MAX = 10_000
        const val AUDIT_KEYS_MAX = 10_000
    }
}
