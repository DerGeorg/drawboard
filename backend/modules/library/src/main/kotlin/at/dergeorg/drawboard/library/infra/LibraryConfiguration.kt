package at.dergeorg.drawboard.library.infra

import at.dergeorg.drawboard.library.common.LibraryModule
import at.dergeorg.drawboard.library.domain.boards.requires.BoardRepository
import at.dergeorg.drawboard.library.domain.boards.requires.TemplateMetrics
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareLinkRepository
import at.dergeorg.drawboard.library.domain.sharing.requires.ShareMetrics
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.time.Clock

@Configuration(proxyBeanMethods = false)
internal class LibraryConfiguration {

    /** Schema `library`, migrations in db/migration/library. */
    @Bean
    fun libraryFlywayModule() = FlywayModule(schema = LibraryModule.NAME)

    /** The gauge `drawboard.boards`. */
    @Bean
    fun boardsGauge(boards: BoardRepository, registry: ObjectProvider<MeterRegistry>, logger: AppLogger) =
        BoardsGauge(boards, registry, logger)

    /** The gauge `drawboard.share.links.active{audience}`. */
    @Bean
    fun sharesGauge(links: ShareLinkRepository, registry: ObjectProvider<MeterRegistry>, clock: Clock, logger: AppLogger) =
        SharesGauge(links, registry, clock, logger)

    /** The counter of the listTemplates calls refused by the rate limit. */
    @Bean
    fun templateMetrics(registry: ObjectProvider<MeterRegistry>): TemplateMetrics = MicrometerTemplateMetrics(registry)

    /** The counters of the link exchanges and guest sessions. */
    @Bean
    fun shareMetrics(registry: ObjectProvider<MeterRegistry>): ShareMetrics = MicrometerShareMetrics(registry)
}
