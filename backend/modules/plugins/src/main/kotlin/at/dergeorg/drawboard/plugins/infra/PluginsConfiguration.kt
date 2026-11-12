package at.dergeorg.drawboard.plugins.infra

import at.dergeorg.drawboard.plugins.common.PluginsModule
import at.dergeorg.drawboard.plugins.domain.plugins.PluginSettings
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
internal class PluginsConfiguration {

    /** Schema `plugins`, migrations in db/migration/plugins. */
    @Bean
    fun pluginsFlywayModule() = FlywayModule(schema = PluginsModule.NAME)

    /** The secret, the origins and the limits; a missing or short secret stops the start (S3.8). */
    @Bean
    fun pluginSettings(properties: PluginsProperties) = PluginSettings(
        appOrigin = properties.appOrigin,
        pluginOrigin = properties.pluginOriginOrNull,
        pseudonymKey = properties.key(),
        installsPerMinute = properties.installsPerMinute,
        storageWritesPerMinute = properties.storageWritesPerMinute,
    )
}
