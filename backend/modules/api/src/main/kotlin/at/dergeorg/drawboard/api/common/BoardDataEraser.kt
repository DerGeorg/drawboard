package at.dergeorg.drawboard.api.common

import at.dergeorg.drawboard.collab.domain.rooms.provides.CollabUseCase
import at.dergeorg.drawboard.files.domain.files.provides.FilesUseCase
import at.dergeorg.drawboard.planning.domain.rounds.provides.PlanningUseCase
import at.dergeorg.drawboard.plugins.domain.plugins.provides.PluginsUseCase
import io.opentelemetry.instrumentation.annotations.WithSpan
import org.springframework.stereotype.Component
import kotlin.uuid.Uuid

/**
 * Deletes everything the other modules keep for boards that were purged for good (S7.7): the drawing (collab), the
 * files and the storage of the plugins. The library commits the purge first, this follows - should the process die in between, what is
  * left is found
 * by the daily sweep of the files (S4.13) or is unreachable (the board is gone). One place, so a module that keeps data
 * per board is added once for the purge by hand, the purge of a folder and the cleanup job.
 */
@Component
internal class BoardDataEraser(
    private val collab: CollabUseCase,
    private val files: FilesUseCase,
    private val plugins: PluginsUseCase,
    private val planning: PlanningUseCase,
) {

    @WithSpan
    suspend fun erase(boardIds: Collection<Uuid>) {
        if (boardIds.isEmpty()) return
        boardIds.forEach { collab.deleteBoardData(it) }
        files.deleteBoardData(boardIds)
        plugins.deleteBoardData(boardIds)
        planning.deleteBoardData(boardIds)
    }
}
