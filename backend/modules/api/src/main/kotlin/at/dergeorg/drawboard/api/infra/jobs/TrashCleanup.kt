package at.dergeorg.drawboard.api.infra.jobs

import at.dergeorg.drawboard.api.common.BoardDataEraser
import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import at.dergeorg.drawboard.shared.logging.AppLogger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.springframework.context.SmartLifecycle
import kotlin.time.Clock
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.seconds

/**
 * The trash cleanup (S7.7): everything that has been in the trash for [DrawboardProperties.trashRetentionDays] days is
 * purged - boards, folders, grants, links - and then everything the other modules keep for the purged boards (drawing data:
 * update log, snapshots, versions; the files, S4.13). The library commits first, collab follows: should the process die in between, the drawing data of a purged
 * board stays stored although nobody can open the board any more (known gap: a sweep for log and snapshots of boards that
 * no longer exist). The other order would be worse: a board that is still listed but has lost its drawing.
 *
 * Single replica, like the rest: one job, no lock. Runs `trashCleanupSeconds` after the start and then at that interval.
 */
internal class TrashCleanup(
    private val trash: TrashUseCase,
    private val eraser: BoardDataEraser,
    private val properties: DrawboardProperties,
    private val clock: Clock,
    private val logger: AppLogger,
) : SmartLifecycle {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var running = false

    /** One pass; returns how many boards were purged. */
    suspend fun runOnce(): Int {
        val purged = trash.purgeExpired(clock.now() - properties.trashRetentionDays.days)
        eraser.erase(purged)
        if (purged.isNotEmpty()) logger.info("trash cleanup purged boards", "library.trash.boards" to purged.size)
        return purged.size
    }

    override fun start() {
        running = true
        scope.launch {
            while (true) {
                delay(properties.trashCleanupSeconds.seconds)
                try {
                    runOnce()
                } catch (e: CancellationException) {
                    throw e
                } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
                    logger.error("trash cleanup failed", e)
                }
            }
        }
    }

    override fun stop() {
        running = false
        scope.cancel()
    }

    override fun isRunning(): Boolean = running
}
