package at.dergeorg.drawboard.users.domain.users.requires.impl

import at.dergeorg.drawboard.users.domain.users.model.UserProfile
import at.dergeorg.drawboard.users.domain.users.requires.UserProfileRepository
import io.opentelemetry.instrumentation.annotations.WithSpan
import kotlinx.coroutines.reactor.awaitSingle
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.springframework.dao.DuplicateKeyException
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.ReactiveTransactionManager
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.reactive.TransactionalOperator
import org.springframework.transaction.reactive.executeAndAwait
import org.springframework.transaction.support.DefaultTransactionDefinition
import kotlin.time.Instant
import kotlin.uuid.Uuid

private const val CANDIDATES = 200

/** Implements the domain's [UserProfileRepository] port with Spring Data R2DBC. */
@Repository
internal class UserProfileRepositoryAdapter(
    private val profiles: UserProfileR2dbcRepository,
    private val template: R2dbcEntityTemplate,
    transactionManager: ReactiveTransactionManager,
) : UserProfileRepository {

    /**
     * The insert runs in a nested transaction (a savepoint inside the caller's transaction): if a concurrent first
     * request of the same user inserted the profile first, only the savepoint is rolled back - the caller's
     * transaction stays usable, reads the winner and goes on. Without it, PostgreSQL would abort the whole
     * transaction at the duplicate key.
     */
    private val savepoint = TransactionalOperator.create(
        transactionManager,
        DefaultTransactionDefinition(TransactionDefinition.PROPAGATION_NESTED),
    )

    @WithSpan
    override suspend fun findById(id: Uuid): UserProfile? = profiles.findById(id)?.toDomain()

    @WithSpan
    override suspend fun findByLogin(issuer: String, subject: String): UserProfile? =
        profiles.findByIssuerAndSubject(issuer, subject)?.toDomain()

    @WithSpan
    override suspend fun findAllById(ids: Collection<Uuid>): List<UserProfile> =
        if (ids.isEmpty()) emptyList() else profiles.findAllById(ids).map { it.toDomain() }.toList()

    /**
     * A LIKE wildcard in [prefix] only widens what the database returns; the exact prefix test below narrows it again.
     * A backslash would narrow it wrongly (it escapes in LIKE), so nobody is found for it.
     */
    @WithSpan
    override suspend fun searchByPrefix(prefix: String, limit: Int): List<UserProfile> {
        if ('\\' in prefix) return emptyList()
        val pageable = PageRequest.of(0, CANDIDATES, Sort.by("username"))
        return profiles.findByUsernameStartingWithIgnoreCaseOrDisplayNameStartingWithIgnoreCase(prefix, prefix, pageable)
            .map { it.toDomain() }.toList()
            .filter { it.username.startsWith(prefix, ignoreCase = true) || it.displayName?.startsWith(prefix, ignoreCase = true) == true }
            .take(limit)
    }

    @WithSpan
    override suspend fun existsByName(name: String): Boolean =
        '\\' !in name && profiles.existsByUsernameIgnoreCaseOrDisplayNameIgnoreCase(name, name)

    @WithSpan
    override suspend fun countLoggedInSince(since: Instant): Long = profiles.countByLastLoginAtAfter(since)

    @WithSpan
    override suspend fun insertIfAbsent(profile: UserProfile): Boolean = try {
        savepoint.executeAndAwait { template.insert(profile.toEntity(version = null)).awaitSingle() }
        true
    } catch (_: DuplicateKeyException) {
        false
    }

    /** `save()` with the version the change is based on: `UPDATE … WHERE id = ? AND version = ?`, version + 1. */
    @WithSpan
    override suspend fun update(profile: UserProfile): UserProfile? = try {
        profiles.save(profile.toEntity(version = profile.version)).toDomain()
    } catch (_: OptimisticLockingFailureException) {
        null
    }
}
