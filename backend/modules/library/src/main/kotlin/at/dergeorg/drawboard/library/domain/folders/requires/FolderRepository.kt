package at.dergeorg.drawboard.library.domain.folders.requires

import at.dergeorg.drawboard.library.domain.folders.model.Folder
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** Persistence port of folders, in domain terms only. Implemented in requires/impl (Spring Data R2DBC). */
internal interface FolderRepository {

    suspend fun findById(id: Uuid): Folder?

    /** Every folder of [ownerId], also those in the trash - the tree of a personal space is small. */
    suspend fun findAllByOwner(ownerId: Uuid): List<Folder>

    /** The folders directly below any of [parentIds], also those in the trash. */
    suspend fun findChildren(parentIds: Collection<Uuid>): List<Folder>

    suspend fun findAllById(ids: Collection<Uuid>): List<Folder>

    /** Folders in the trash that were deleted before [before] - for the cleanup. */
    suspend fun findDeletedBefore(before: Instant): List<Folder>

    suspend fun insert(folder: Folder): Folder

    /** Stores the changes if the stored version is still `folder.version`; null if a concurrent change won. */
    suspend fun update(folder: Folder): Folder?

    /** Sets or clears (`at` null) `deletedAt` of all [ids] without touching their versions. */
    suspend fun setDeletedAt(ids: Collection<Uuid>, at: Instant?)

    suspend fun deleteAll(ids: Collection<Uuid>)
}
