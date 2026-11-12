package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.sharing.model.ShareAudience
import at.dergeorg.drawboard.library.domain.sharing.model.ShareLink
import at.dergeorg.drawboard.library.domain.sharing.requires.PasswordHasher
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareMetrics
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fake of the internal [ShareLinkRepository] port. */
internal class InMemoryShareLinkRepository(vararg initial: ShareLink) : ShareLinkRepository {
    private val links = linkedMapOf<Uuid, ShareLink>().apply { initial.forEach { put(it.id, it) } }

    val all: List<ShareLink> get() = links.values.toList()

    override suspend fun insert(link: ShareLink): ShareLink = link.also { links[it.id] = it }

    override suspend fun findById(id: Uuid) = links[id]

    override suspend fun findByTokenHash(hash: String) = links.values.firstOrNull { it.tokenHash == hash }

    override suspend fun findByResource(kind: ResourceKind, resourceId: Uuid) =
        links.values.filter { it.resourceKind == kind && it.resourceId == resourceId }.sortedByDescending { it.createdAt }

    override suspend fun findAllById(ids: Collection<Uuid>) = links.values.filter { it.id in ids }

    override suspend fun revoke(id: Uuid, at: Instant): Boolean {
        val link = links[id]?.takeIf { it.revokedAt == null } ?: return false
        links[id] = link.copy(revokedAt = at)
        return true
    }

    override suspend fun incrementUseCount(id: Uuid) {
        links[id]?.let { links[id] = it.copy(useCount = it.useCount + 1) }
    }

    override suspend fun deleteByResources(kind: ResourceKind, ids: Collection<Uuid>) {
        links.values.removeAll { it.resourceKind == kind && it.resourceId in ids }
    }

    override suspend fun countUsable(audience: ShareAudience, now: Instant) =
        links.values.count { it.audience == audience && it.usable(now) }.toLong()
}

/** A "hash" that is cheap and checkable: `hashed:<password>`. The real Argon2 is tested on its own. */
internal class FakePasswordHasher : PasswordHasher {
    override suspend fun hash(password: String) = "hashed:$password"

    override suspend fun matches(password: String, hash: String) = hash == "hashed:$password"
}

internal class RecordingShareMetrics : ShareMetrics {
    val exchanges = mutableListOf<String>()
    var guestSessions = 0

    override fun exchange(result: String) {
        exchanges += result
    }

    override fun guestSession() {
        guestSessions++
    }
}
