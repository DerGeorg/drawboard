package at.dergeorg.drawboard.auditing.infra

import at.dergeorg.drawboard.auditing.common.DetailsTypeRegistry
import at.dergeorg.drawboard.shared.persistence.FlywayModule
import org.springframework.beans.factory.BeanFactory
import org.springframework.boot.autoconfigure.AutoConfigurationPackages
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
internal class AuditingConfiguration {

    /** Schema `auditing`, migrated first (no dependency on it, just a deterministic order). */
    @Bean
    fun auditingFlywayModule() = FlywayModule(schema = "auditing", order = -100)

    /** Details classes are searched where the application lives: the package of @SpringBootApplication and below. */
    @Bean
    fun detailsTypeRegistry(beanFactory: BeanFactory) = DetailsTypeRegistry(AutoConfigurationPackages.get(beanFactory))
}
