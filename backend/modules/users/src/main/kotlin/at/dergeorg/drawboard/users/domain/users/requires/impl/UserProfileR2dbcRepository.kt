package at.dergeorg.drawboard.users.domain.users.requires.impl

import kotlinx.coroutines.flow.Flow
import org.springframework.data.domain.Pageable
import org.springframework.data.repository.kotlin.CoroutineCrudRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/**
 * Spring Data R2DBC repository (coroutines), derived queries only - no SQL in the code. Only
 * [UserProfileRepositoryAdapter] uses it: for reading and for `save()` of a changed profile. New profiles are
 * inserted with R2dbcEntityTemplate.insert() - the id is set by us, so `save()` could not tell "new".
 */
internal interface UserProfileR2dbcRepository : CoroutineCrudRepository<UserProfileEntity, Uuid> {

    suspend fun findByIssuerAndSubject(issuer: String, subject: String): UserProfileEntity?

    fun findByUsernameStartingWithIgnoreCaseOrDisplayNameStartingWithIgnoreCase(
        username: String,
        displayName: String,
        pageable: Pageable,
    ): Flow<UserProfileEntity>

    suspend fun existsByUsernameIgnoreCaseOrDisplayNameIgnoreCase(username: String, displayName: String): Boolean

    suspend fun countByLastLoginAtAfter(since: Instant): Long
}
