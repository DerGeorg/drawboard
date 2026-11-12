// The one place that creates SLF4J loggers: everything else gets an AppLogger injected (detekt bans LoggerFactory).
@file:Suppress("ForbiddenImport")

package at.dergeorg.drawboard.core.infra.observability

import at.dergeorg.drawboard.shared.logging.AppLogger
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.InjectionPoint
import org.springframework.beans.factory.config.ConfigurableBeanFactory
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Scope

@Configuration(proxyBeanMethods = false)
internal class LoggingConfiguration {

    /**
     * One logger per injection point, named after the class that receives it - like getLogger(javaClass), but
     * injected: `class XService(..., private val log: AppLogger)`. For a @Bean method parameter it is the
     * configuration class that declares the method.
     */
    @Bean
    @Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
    fun appLogger(injectionPoint: InjectionPoint): AppLogger =
        Slf4jAppLogger(LoggerFactory.getLogger(injectionPoint.member.declaringClass))
}
