package at.dergeorg.drawboard.api.infra.jobs

import at.dergeorg.drawboard.api.common.BoardDataEraser
import at.dergeorg.drawboard.api.common.DrawboardProperties
import at.dergeorg.drawboard.library.domain.trash.provides.TrashUseCase
import at.dergeorg.drawboard.planning.domain.sessions.provides.EstimationUseCase
import at.dergeorg.drawboard.shared.logging.AppLogger
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.time.Clock

@Configuration(proxyBeanMethods = false)
internal class JobsConfiguration {

    /** The scheduled trash cleanup (S7.7) and retention purge of the estimation sessions (E22). */
    @Bean
    fun trashCleanup(
        trash: TrashUseCase,
        eraser: BoardDataEraser,
        estimation: EstimationUseCase,
        properties: DrawboardProperties,
        clock: Clock,
        logger: AppLogger,
    ) = TrashCleanup(trash, eraser, estimation, properties, clock, logger)
}
