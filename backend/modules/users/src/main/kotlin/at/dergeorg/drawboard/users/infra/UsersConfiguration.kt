package at.dergeorg.drawboard.users.infra

import at.dergeorg.drawboard.shared.persistence.FlywayModule
import at.dergeorg.drawboard.users.common.UsersModule
import at.dergeorg.drawboard.shared.logging.AppLogger
import at.dergeorg.drawboard.users.domain.users.requires.UserProfileRepository
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.time.Clock

@Configuration(proxyBeanMethods = false)
internal class UsersConfiguration {

    /** Schema `users`, migrations in db/migration/users. ("user" itself is a reserved word in PostgreSQL.) */
    @Bean
    fun usersFlywayModule() = FlywayModule(schema = UsersModule.NAME)

    /** The gauges `drawboard.users.active{window}`. */
    @Bean
    fun usersActiveGauge(profiles: UserProfileRepository, registry: ObjectProvider<MeterRegistry>, clock: Clock, logger: AppLogger) =
        UsersActiveGauge(profiles, registry, clock, logger)
}
