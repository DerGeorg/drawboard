package at.dergeorg.drawboard.gifs.infra

import at.dergeorg.drawboard.gifs.domain.search.GifsSettings
import at.dergeorg.drawboard.gifs.domain.search.requires.GifsMetrics
import at.dergeorg.drawboard.shared.logging.AppLogger
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.SmartInitializingSingleton
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
internal class GifsConfiguration {

    /** The key, the rating and the budget (G1, G6, G7). A key of the wrong shape or an unknown rating stops the start. */
    @Bean
    fun gifsSettings(properties: GifsProperties): GifsSettings = properties.toSettings()

    @Bean
    fun gifsMetrics(registry: ObjectProvider<MeterRegistry>): GifsMetrics = MicrometerGifsMetrics(registry)

    /** The one line the module writes at the start (G1). No call to GIPHY is made here. */
    @Bean
    fun gifsStartupLog(settings: GifsSettings, logger: AppLogger): SmartInitializingSingleton = SmartInitializingSingleton {
        logger.info("GIF search", "gifs.enabled" to settings.enabled, "gifs.rating" to settings.rating.wire)
    }
}
