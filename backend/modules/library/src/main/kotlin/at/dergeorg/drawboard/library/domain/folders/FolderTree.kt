package at.dergeorg.drawboard.library.domain.folders


import at.dergeorg.drawboard.library.domain.folders.model.Folder
import kotlin.uuid.Uuid

/** Walks the folder tree of one owner in memory (a personal space is small). */
internal object FolderTree {

    /** [root] and every folder below it, found in [all] (the folders of the same owner). */
    fun subtree(root: Folder, all: Collection<Folder>): List<Folder> {
        val children = all.groupBy { it.parentId }
        val result = ArrayList<Folder>()
        val seen = HashSet<Uuid>()
        val queue = ArrayDeque(listOf(root))
        while (queue.isNotEmpty()) {
            val folder = queue.removeFirst()
            if (!seen.add(folder.id)) continue
            result += folder
            queue += children[folder.id].orEmpty()
        }
        return result
    }
}
