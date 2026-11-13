package at.dergeorg.drawboard.library.domain

import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Fake of the internal [FolderRepository] port; [update] checks the version like the real adapter. */
internal class InMemoryFolderRepository(vararg initial: Folder) : FolderRepository {
    private val folders = linkedMapOf<Uuid, Folder>().apply { initial.forEach { put(it.id, it) } }

    val all: List<Folder> get() = folders.values.toList()

    var lookups = 0

    override suspend fun findById(id: Uuid): Folder? {
        lookups++
        return folders[id]
    }

    override suspend fun findAllByOwner(ownerId: Uuid) = folders.values.filter { it.ownerId == ownerId }

    var childQueries = 0

    override suspend fun findChildren(parentIds: Collection<Uuid>): List<Folder> {
        childQueries++
        return folders.values.filter { it.parentId in parentIds }
    }

    override suspend fun findAllById(ids: Collection<Uuid>) = folders.values.filter { it.id in ids }

    override suspend fun findDeletedBefore(before: Instant) = folders.values.filter { (it.deletedAt ?: Instant.DISTANT_FUTURE) < before }

    override suspend fun insert(folder: Folder): Folder = folder.copy(version = 0).also { folders[it.id] = it }

    override suspend fun update(folder: Folder): Folder? {
        val stored = folders[folder.id]
        if (stored == null || stored.version != folder.version) return null
        return folder.copy(version = folder.version + 1).also { folders[it.id] = it }
    }

    override suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?) {
        ids.forEach { id -> folders[id]?.let { folders[id] = it.copy(deletedAt = at) } }
    }

    override suspend fun deleteAll(ids: Collection<Uuid>) {
        ids.forEach(folders::remove)
    }
}
