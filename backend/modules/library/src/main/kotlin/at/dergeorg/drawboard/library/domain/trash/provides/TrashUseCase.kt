package at.dergeorg.drawboard.library.domain.trash.provides

import at.dergeorg.drawboard.library.domain.access.model.Caller
import at.dergeorg.drawboard.library.domain.boards.model.Board
import at.dergeorg.drawboard.library.domain.boards.model.BoardView
import at.dergeorg.drawboard.library.domain.folders.model.Folder
import at.dergeorg.drawboard.library.domain.folders.model.FolderView
import kotlin.time.Instant
import kotlin.uuid.Uuid

/** The trash of a personal space (S7.7): 30 days after the deletion everything in it is purged for good. */
interface TrashUseCase {

    /** The caller's deleted boards and folders - one entry per deletion (what was deleted together is not listed again). */
    suspend fun listTrash(caller: Caller): TrashView

    /** Back into its folder, or the root when the folder is in the trash or gone. 404 for what is not in the caller's trash. */
    suspend fun restoreBoard(caller: Caller, boardId: Uuid): BoardView

    /** Like [restoreBoard], with everything that was deleted together with the folder. */
    suspend fun restoreFolder(caller: Caller, folderId: Uuid): FolderView

    /** Deletes the board for good. Returns the ids of the boards gone (the drawing data must be deleted by the caller). */
    suspend fun purgeBoard(caller: Caller, boardId: Uuid): List<Uuid>

    /** Deletes the folder and everything below it for good. Returns the ids of the boards gone. */
    suspend fun purgeFolder(caller: Caller, folderId: Uuid): List<Uuid>

    /** The cleanup job: purges everything in the trash since before [deletedBefore]. Returns the ids of the boards gone. */
    suspend fun purgeExpired(deletedBefore: Instant): List<Uuid>
}

data class TrashView(val boards: List<Board>, val folders: List<Folder>)
