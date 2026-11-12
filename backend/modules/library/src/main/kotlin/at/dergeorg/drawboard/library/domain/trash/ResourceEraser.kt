package at.dergeorg.drawboard.library.domain.trash

import at.dergeorg.drawboard.library.domain.access.model.ResourceKind
import at.dergeorg.drawboard.library.domain.access.requires.GrantRepository
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.folders.requires.FolderRepository
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import org.springframework.stereotype.Component
import kotlin.uuid.Uuid

/** Deletes boards and folders for good together with everything that hangs on them (grants and share links). */
@Component
internal class ResourceEraser(
    private val boards: BoardRepository,
    private val folders: FolderRepository,
    private val grants: GrantRepository,
    private val links: ShareLinkRepository,
) {

    suspend fun erase(boardIds: Collection<Uuid>, folderIds: Collection<Uuid>) {
        grants.removeByResources(ResourceKind.BOARD, boardIds)
        grants.removeByResources(ResourceKind.FOLDER, folderIds)
        links.deleteByResources(ResourceKind.BOARD, boardIds)
        links.deleteByResources(ResourceKind.FOLDER, folderIds)
        boards.deleteAll(boardIds)
        folders.deleteAll(folderIds)
    }
}
