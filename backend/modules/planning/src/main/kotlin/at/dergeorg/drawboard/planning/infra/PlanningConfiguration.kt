package at.dergeorg.drawboard.planning.infra

import at.dergeorg.drawboard.planning.common.PlanningModule
import at.dergeorg.drawboard.planning.domain.rounds.PlanningSettings
import at.dergeorg.drawboard.planning.domain.rounds.requires.PlanningMetrics
import at.dergeorg.drawboard.planning.domain.sessions.EstimationLimits
import at.dergeorg.drawboard.planning.domain.sessions.requires.EstimationMetrics
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import io.micrometer.core.instrument.MeterRegistry
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
internal class PlanningConfiguration {

    /** Schema `planning`, migrations in db/migration/planning. */
    @Bean
    fun planningFlywayModule() = FlywayModule(schema = PlanningModule.NAME)

    @Bean
    fun planningSettings(properties: PlanningProperties): PlanningSettings = properties.toSettings()

    @Bean
    fun planningMetrics(registry: ObjectProvider<MeterRegistry>): PlanningMetrics = MicrometerPlanningMetrics(registry)

    @Bean
    fun estimationLimits(properties: EstimationProperties): EstimationLimits = properties.toLimits()

    @Bean
    fun estimationMetrics(registry: ObjectProvider<MeterRegistry>): EstimationMetrics = MicrometerEstimationMetrics(registry)
}
